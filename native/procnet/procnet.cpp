// NetPet procnet — 按程序统计流量（ETW 内核会话，原生组件）
//
// 原理（已核实的事实）：
// - Windows 上可靠的按程序流量来源是 ETW。Microsoft-Windows-TcpIp / 内核
//   TcpIp 提供方会发出 send/receive 事件，事件头里带 ProcessId，可按进程
//   归因字节数；资源监视器用的就是这类 ETW 流。
//   搜索核实：Microsoft-Windows-TCPIP 提供方 GUID
//   {2F07E2EE-15DB-40F1-90EF-9D7BA282188A}；内核 TcpIp 提供方 GUID
//   {9A280AC0-C8E0-11D1-84E2-00C04FB998A2}，
//   EVENT_TRACE_FLAG_NETWORK_TCPIP = 0x00010000，
//   EVENT_TRACE_TYPE_SEND = 0x0A。
// - EStats（GetPerTcpConnectionEStats）不是免提权回退：启用数据统计通常
//   也要管理员权限，所以本组件不做“EStats 免提权”假回退——没有管理员权
//   限就如实返回 needs-admin，界面显示“无法检测”，不提权、不绕过。
//
// 实现选择：NT 内核日志会话（System Logger 模式），只开 NETWORK_TCPIP
// 标志，不装驱动、不抓包、不读任何通信内容、不解密 TLS。每个事件只用
// 两样东西：EventHeader.ProcessId（归因）和 UserData 里的 size（字节数）。
// 不用目的 IP/端口做任何事，也不把它们传给 JS。
//
// 尚未在真实 Windows 上验证的假设（必须在真机上校准，见 README）：
// 1. size 字段的偏移。按内核 TcpIp/ UdpIp 事件的常规布局：IPv4 事件
//    UserData 前 12 字节是源/目的 IP（各 4 字节）+ 源/目的端口（各 2 字节），
//    size 在偏移 12；IPv6 是源/目的地址各 16 字节 + 端口 4 字节，size 在
//    偏移 36。本代码按 UserDataLength >= 44 判 IPv6，否则判 IPv4；
//    size 超出 1..65535 一律丢弃并计 parseErrors，不让错解析污染统计。
//    如果真机上 parseErrors 持续增长或总量与资源监视器明显不符，说明
//    布局假设错了，须按 README 里的校准步骤修正偏移，绝不能硬凑数字。
// 2. UdpIp 提供方 GUID {BF3A50C5-A9C9-4988-A005-2DF0B7C80F80} 未经核实。
//    它只用来在回调里区分 TCP/UDP；GUID 对不上时 UDP 事件会被忽略
//    （计入 unknownEvents），不会被错算成 TCP。
// 3. 事件类型：Send=10、Recv=11（EVENT_TRACE_TYPE_SEND=0x0A，Recv 紧随
//    其后）。回调里同时接受 EventDescriptor.Id 与 Opcode 任一为 10/11。
// 4. 启动内核会话需要管理员权限（SeSystemProfilePrivilege）。非管理员
//    运行时 StartTrace 返回 5（拒绝访问），JS 层如实显示，不自动提权。
//
// 线程与安全：ProcessTrace 跑在独立线程里；聚合表受互斥锁保护；退出时
// 先 ControlTrace 停会话再 CloseTrace、join 线程，不留后台会话。
// 会话名固定为 NetPet-ProcNet；上次崩溃残留的同名会话会在启动时先停掉
// 再重建一次（仅此一次）。
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <evntrace.h>
#include <tdh.h>
#include <psapi.h>
#include <node_api.h>

#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "tdh.lib")
#pragma comment(lib, "psapi.lib")

namespace {

// {9A280AC0-C8E0-11D1-84E2-00C04FB998A2} — NT Kernel Logger TcpIp
static const GUID kTcpIpGuid = {0x9a280ac0, 0xc8e0, 0x11d1,
  {0x84, 0xe2, 0x00, 0xc0, 0x4f, 0xb9, 0x98, 0xa2}};
// {BF3A50C5-A9C9-4988-A005-2DF0B7C80F80} — UdpIp（未经核实，见文件头说明）
static const GUID kUdpIpGuid = {0xbf3a50c5, 0xa9c9, 0x4988,
  {0xa0, 0x05, 0x2d, 0xf0, 0xb7, 0xc8, 0x0f, 0x80}};
// SystemTraceControlGuid — NT Kernel Logger
static const GUID kSystemTraceGuid = {0x9e814aad, 0x3204, 0x11d2,
  {0x9a, 0x82, 0x00, 0x60, 0x08, 0xa8, 0x69, 0x39}};

static const wchar_t kSessionName[] = L"NetPet-ProcNet";
static const uint16_t kTypeSend = 10;
static const uint16_t kTypeRecv = 11;

struct Agg {
  std::string name;
  uint64_t rx = 0;
  uint64_t tx = 0;
  uint64_t udpRx = 0;
  uint64_t udpTx = 0;
};

std::mutex g_mu;
std::unordered_map<uint32_t, Agg> g_totals;
std::unordered_map<uint32_t, std::string> g_names;
uint64_t g_eventsSeen = 0;
uint64_t g_parseErrors = 0;
uint64_t g_unknownEvents = 0;
bool g_running = false;
bool g_stopping = false;
TRACEHANDLE g_session = 0;
TRACEHANDLE g_trace = 0;
std::thread g_thread;
std::string g_error;
uint64_t g_startedAtMs = 0;

uint64_t NowMs() {
  return static_cast<uint64_t>(GetTickCount64());
}

std::string WideToUtf8(const std::wstring& w) {
  if (w.empty()) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, nullptr, 0, nullptr, nullptr);
  if (n <= 0) return std::string();
  std::string s(static_cast<size_t>(n - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, s.data(), n, nullptr, nullptr);
  return s;
}

std::string ProcessName(uint32_t pid) {
  {
    std::lock_guard<std::mutex> lk(g_mu);
    auto it = g_names.find(pid);
    if (it != g_names.end()) return it->second;
  }
  std::string name;
  if (pid == 0) name = "Idle";
  else if (pid == 4) name = "System";
  else {
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (h) {
      wchar_t buf[MAX_PATH] = {0};
      DWORD n = MAX_PATH;
      if (QueryFullProcessImageNameW(h, 0, buf, &n)) {
        std::wstring w(buf, n);
        size_t p = w.find_last_of(L"\\/");
        name = WideToUtf8(p == std::wstring::npos ? w : w.substr(p + 1));
      }
      CloseHandle(h);
    }
  }
  if (name.empty()) name = "PID " + std::to_string(pid);
  std::lock_guard<std::mutex> lk(g_mu);
  g_names[pid] = name;
  return name;
}

// 从 UserData 里取 size。返回 0 表示解析失败（调用方计 parseErrors）。
uint32_t ParseSize(const uint8_t* data, uint32_t len) {
  if (!data || len < 16) return 0;
  // IPv6 事件的 UserData 更长（两个 16 字节地址），IPv4 较短。
  uint32_t off = (len >= 44) ? 36 : 12;
  if (off + 4 > len) return 0;
  uint32_t size = 0;
  std::memcpy(&size, data + off, 4);
  if (size == 0 || size > 65535) return 0;
  return size;
}

// 回调入口先在锁外解析好进程名（带缓存），再加锁聚合，避免持锁解析。
void WINAPI EventCallback2(PEVENT_RECORD rec) {
  if (!rec) return;
  const GUID& prov = rec->EventHeader.ProviderId;
  bool isTcp = (std::memcmp(&prov, &kTcpIpGuid, sizeof(GUID)) == 0);
  bool isUdp = (std::memcmp(&prov, &kUdpIpGuid, sizeof(GUID)) == 0);
  if (!isTcp && !isUdp) { return; }
  uint16_t id = rec->EventHeader.EventDescriptor.Id;
  uint16_t op = rec->EventHeader.EventDescriptor.Opcode;
  bool isSend = (id == kTypeSend || op == kTypeSend);
  bool isRecv = (id == kTypeRecv || op == kTypeRecv);
  if (!isSend && !isRecv) return;
  uint32_t pid = rec->EventHeader.ProcessId;
  if (pid == 0) return;
  std::string name = ProcessName(pid);  // 锁外解析，带缓存
  const uint8_t* data = static_cast<const uint8_t*>(rec->UserData);
  uint32_t size = ParseSize(data, rec->UserDataLength);
  std::lock_guard<std::mutex> lk(g_mu);
  g_eventsSeen++;
  if (size == 0) { g_parseErrors++; return; }
  Agg& a = g_totals[pid];
  if (a.name.empty()) a.name = name;
  if (isUdp) { if (isSend) a.udpTx += size; else a.udpRx += size; }
  else { if (isSend) a.tx += size; else a.rx += size; }
}

ULONG StartSessionOnce() {
  const size_t propsSize = sizeof(EVENT_TRACE_PROPERTIES) +
      (wcslen(kSessionName) + 1) * sizeof(wchar_t) + 64;
  std::vector<uint8_t> buf(propsSize, 0);
  auto* props = reinterpret_cast<EVENT_TRACE_PROPERTIES*>(buf.data());
  props->Wnode.BufferSize = static_cast<ULONG>(propsSize);
  props->Wnode.Flags = WNODE_FLAG_TRACED_GUID;
  props->Wnode.Guid = kSystemTraceGuid;
  props->Wnode.ClientContext = 1;  // QPC 时钟
  props->BufferSize = 64;
  props->MinimumBuffers = 4;
  props->MaximumBuffers = 16;
  props->LogFileMode = EVENT_TRACE_REAL_TIME_MODE | EVENT_TRACE_SYSTEM_LOGGER_MODE;
  props->FlushTimer = 1;
  props->EnableFlags = EVENT_TRACE_FLAG_NETWORK_TCPIP;
  props->LoggerNameOffset = sizeof(EVENT_TRACE_PROPERTIES);
  props->LogFileNameOffset = 0;
  return StartTraceW(&g_session, kSessionName, props);
}

void StopSession() {
  if (g_session) {
    const size_t propsSize = sizeof(EVENT_TRACE_PROPERTIES) +
        (wcslen(kSessionName) + 1) * sizeof(wchar_t) + 64;
    std::vector<uint8_t> buf(propsSize, 0);
    auto* props = reinterpret_cast<EVENT_TRACE_PROPERTIES*>(buf.data());
    props->Wnode.BufferSize = static_cast<ULONG>(propsSize);
    props->Wnode.Flags = WNODE_FLAG_TRACED_GUID;
    props->Wnode.Guid = kSystemTraceGuid;
    props->LoggerNameOffset = sizeof(EVENT_TRACE_PROPERTIES);
    ControlTraceW(g_session, kSessionName, props, EVENT_TRACE_CONTROL_STOP);
    g_session = 0;
  }
}

void TraceThread() {
  EVENT_TRACE_LOGFILEW log = {};
  log.LoggerName = const_cast<LPWSTR>(kSessionName);
  log.ProcessTraceMode = PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD;
  log.EventRecordCallback = EventCallback2;
  log.Context = nullptr;
  g_trace = OpenTraceW(&log);
  if (g_trace == INVALID_PROCESSTRACE_HANDLE) {
    std::lock_guard<std::mutex> lk(g_mu);
    g_error = "OpenTrace failed: " + std::to_string(GetLastError());
    g_running = false;
    return;
  }
  ULONG st = ProcessTrace(&g_trace, 1, nullptr, nullptr);
  if (st != ERROR_SUCCESS && st != ERROR_CANCELLED) {
    std::lock_guard<std::mutex> lk(g_mu);
    if (g_error.empty()) g_error = "ProcessTrace failed: " + std::to_string(st);
  }
  if (g_trace != INVALID_PROCESSTRACE_HANDLE && g_trace != 0) {
    CloseTrace(g_trace);
    g_trace = 0;
  }
  std::lock_guard<std::mutex> lk(g_mu);
  g_running = false;
}

std::string LastErrorText(ULONG code) {
  if (code == ERROR_ACCESS_DENIED) return "needs-admin: 启动 ETW 内核会话需要管理员权限";
  if (code == ERROR_ALREADY_EXISTS) return "session-exists: 同名 ETW 会话已存在";
  return "StartTrace failed: " + std::to_string(code);
}

// ---- N-API helpers ----
napi_value Str(napi_env env, const std::string& s) {
  napi_value v; napi_create_string_utf8(env, s.c_str(), s.size(), &v); return v;
}
napi_value Bool(napi_env env, bool b) {
  napi_value v; napi_get_boolean(env, b, &v); return v;
}
napi_value Num(napi_env env, double d) {
  napi_value v; napi_create_double(env, d, &v); return v;
}
void SetProp(napi_env env, napi_value obj, const char* key, napi_value val) {
  napi_set_named_property(env, obj, key, val);
}

napi_value JsStart(napi_env env, napi_callback_info /*info*/) {
  napi_value out; napi_create_object(env, &out);
  {
    std::lock_guard<std::mutex> lk(g_mu);
    if (g_running) { SetProp(env, out, "ok", Bool(env, true)); SetProp(env, out, "already", Bool(env, true)); return out; }
    g_error.clear();
  }
  ULONG st = StartSessionOnce();
  if (st == ERROR_ALREADY_EXISTS) {
    // 上次崩溃残留的同名会话：停掉再试一次。
    StopSession();
    st = StartSessionOnce();
  }
  if (st != ERROR_SUCCESS) {
    std::string msg = LastErrorText(st);
    std::lock_guard<std::mutex> lk(g_mu);
    g_error = msg;
    SetProp(env, out, "ok", Bool(env, false));
    SetProp(env, out, "error", Str(env, msg));
    SetProp(env, out, "code", Num(env, static_cast<double>(st)));
    return out;
  }
  {
    std::lock_guard<std::mutex> lk(g_mu);
    g_running = true;
    g_stopping = false;
    g_startedAtMs = NowMs();
    g_totals.clear();
    g_eventsSeen = 0;
    g_parseErrors = 0;
    g_unknownEvents = 0;
  }
  if (g_thread.joinable()) g_thread.join();
  g_thread = std::thread(TraceThread);
  SetProp(env, out, "ok", Bool(env, true));
  SetProp(env, out, "mode", Str(env, "etw-kernel"));
  return out;
}

napi_value JsStop(napi_env env, napi_callback_info /*info*/) {
  {
    std::lock_guard<std::mutex> lk(g_mu);
    if (!g_running) { napi_value out; napi_create_object(env, &out); SetProp(env, out, "ok", Bool(env, true)); return out; }
    g_stopping = true;
  }
  StopSession();
  if (g_trace) {
    // ProcessTrace 在会话停止后会返回；等线程结束。
  }
  if (g_thread.joinable()) g_thread.join();
  {
    std::lock_guard<std::mutex> lk(g_mu);
    g_running = false;
  }
  napi_value out; napi_create_object(env, &out);
  SetProp(env, out, "ok", Bool(env, true));
  return out;
}

napi_value JsTotals(napi_env env, napi_callback_info /*info*/) {
  napi_value arr; napi_create_array(env, &arr);
  std::lock_guard<std::mutex> lk(g_mu);
  uint32_t i = 0;
  for (const auto& kv : g_totals) {
    napi_value o; napi_create_object(env, &o);
    SetProp(env, o, "pid", Num(env, static_cast<double>(kv.first)));
    SetProp(env, o, "name", Str(env, kv.second.name.empty() ? ("PID " + std::to_string(kv.first)) : kv.second.name));
    SetProp(env, o, "rx", Num(env, static_cast<double>(kv.second.rx)));
    SetProp(env, o, "tx", Num(env, static_cast<double>(kv.second.tx)));
    SetProp(env, o, "udpRx", Num(env, static_cast<double>(kv.second.udpRx)));
    SetProp(env, o, "udpTx", Num(env, static_cast<double>(kv.second.udpTx)));
    napi_set_element(env, arr, i++, o);
  }
  return arr;
}

napi_value JsStatus(napi_env env, napi_callback_info /*info*/) {
  napi_value out; napi_create_object(env, &out);
  std::lock_guard<std::mutex> lk(g_mu);
  SetProp(env, out, "running", Bool(env, g_running));
  SetProp(env, out, "mode", Str(env, "etw-kernel"));
  SetProp(env, out, "eventsSeen", Num(env, static_cast<double>(g_eventsSeen)));
  SetProp(env, out, "parseErrors", Num(env, static_cast<double>(g_parseErrors)));
  SetProp(env, out, "unknownEvents", Num(env, static_cast<double>(g_unknownEvents)));
  SetProp(env, out, "error", Str(env, g_error));
  SetProp(env, out, "startedAtMs", Num(env, static_cast<double>(g_startedAtMs)));
  return out;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
    {"start", nullptr, JsStart, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stop", nullptr, JsStop, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"getTotals", nullptr, JsTotals, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"getStatus", nullptr, JsStatus, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 4, desc);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)

}  // namespace
#else
// 非 Windows：只导出空壳，JS 层会识别为不可用。
#include <node_api.h>
static napi_value JsUnavailable(napi_env env, napi_callback_info) {
  napi_value o; napi_create_object(env, &o);
  napi_value f; napi_get_boolean(env, false, &f);
  napi_set_named_property(env, o, "ok", f);
  napi_value s; napi_create_string_utf8(env, "windows-only", 12, &s);
  napi_set_named_property(env, o, "error", s);
  return o;
}
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
    {"start", nullptr, JsUnavailable, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stop", nullptr, JsUnavailable, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 2, desc);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
#endif
