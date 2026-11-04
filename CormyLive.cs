using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace CormyLive {
  public sealed class Settings {
    public string Title = "可米直播";
    public string TaskName = "Cormy.Live";
    public string Root;
    public string Node;
    public string Entry = "bin/cortico.mjs";
    public string Deployment = "cortiv";
    public string ConsoleUrl = "http://127.0.0.1:7789";
    public string ViewerUrl = "http://127.0.0.1:7793";
    public string ObserverWorld = "mymc";
    public string DataDir;
    public bool StartPaused = false;
    public string ConfigPath;
    public string StatePath { get { return Path.Combine(DataDir, "worker.json"); } }
    public static Settings Load(string path) {
      var cfg = Json.Read<Settings>(path);
      cfg.ConfigPath = Path.GetFullPath(path);
      if (String.IsNullOrWhiteSpace(cfg.Root) || String.IsNullOrWhiteSpace(cfg.Node) || String.IsNullOrWhiteSpace(cfg.DataDir))
        throw new InvalidDataException("启动配置缺少安装目录。");
      foreach (var address in new [] { cfg.ConsoleUrl, cfg.ViewerUrl }) {
        var uri = new Uri(address);
        if (!uri.IsLoopback || uri.Scheme != "http") throw new InvalidDataException("控制接口必须是本机 HTTP 地址。");
      }
      Directory.CreateDirectory(cfg.DataDir);
      return cfg;
    }
  }

  public static class Json {
    public static T Read<T>(string path) { return Serializer().Deserialize<T>(File.ReadAllText(path, Encoding.UTF8)); }
    public static JavaScriptSerializer Serializer() { return new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 }; }
    public static void Write(string path, object value) {
      Directory.CreateDirectory(Path.GetDirectoryName(path));
      var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
      File.WriteAllText(temp, Serializer().Serialize(value), new UTF8Encoding(false));
      if (File.Exists(path)) File.Replace(temp, path, null); else File.Move(temp, path);
    }
    public static object Get(object root, params string[] path) {
      foreach (var key in path) {
        var dict = root as Dictionary<string, object>;
        if (dict == null || !dict.TryGetValue(key, out root)) return null;
      }
      return root;
    }
    public static bool IsTrue(object value) { return value is bool && (bool)value; }
  }

  public static class Runtime {
    public static string Quote(string value) {
      var text = new StringBuilder("\""); int slash = 0;
      foreach (char c in value) {
        if (c == '\\') { slash++; continue; }
        if (c == '"') { text.Append('\\', slash * 2 + 1); text.Append(c); slash = 0; continue; }
        text.Append('\\', slash); slash = 0; text.Append(c);
      }
      text.Append('\\', slash * 2); return text.Append('"').ToString();
    }

    public static void RunTask(string name) {
      dynamic scheduler = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));
      try { scheduler.Connect(); dynamic folder = scheduler.GetFolder("\\"); dynamic task = folder.GetTask(name); task.Run(null); }
      finally { Marshal.FinalReleaseComObject(scheduler); }
    }

    public static async Task<object> Api(Settings cfg, string route, bool post = false, int seconds = 3, object body = null) {
      using (var handler = new HttpClientHandler { UseProxy = false })
      using (var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(seconds) }) {
        client.DefaultRequestHeaders.Add("x-cortico-language", "zh-CN");
        HttpResponseMessage response = post
          ? await client.PostAsync(cfg.ConsoleUrl.TrimEnd('/') + route, new StringContent(body == null ? "{}" : Json.Serializer().Serialize(body), Encoding.UTF8, "application/json"))
          : await client.GetAsync(cfg.ConsoleUrl.TrimEnd('/') + route);
        using (response) {
          if (response.StatusCode == HttpStatusCode.Unauthorized) throw new InvalidOperationException("请在控制台登录后操作。");
          response.EnsureSuccessStatusCode();
          return Json.Serializer().DeserializeObject(await response.Content.ReadAsStringAsync());
        }
      }
    }

    public sealed class ObserverOpenResult {
      public bool started, activated;
      public int pid;
      public string phase;
    }

    public static async Task<ObserverOpenResult> OpenObserver(Settings cfg) {
      string route = "/api/webui/providers/" + Uri.EscapeDataString("world:" + cfg.ObserverWorld) + "/panels/mount/client.";
      var args = new { args = new object[0] };
      var state = await Api(cfg, route + "state", true, 8, args);
      var result = new ObserverOpenResult();
      var initialPhase=Convert.ToString(Json.Get(state,"phase"));
      if (initialPhase=="stopped" || initialPhase=="error" || initialPhase=="failed") {
        bool reconcile=false;
        try { state = await Api(cfg, route + "start", true, 30, args); }
        catch(TaskCanceledException) { reconcile=true; }
        catch(HttpRequestException) { reconcile=true; }
        if(reconcile)state=await Api(cfg,route+"state",true,10,args);
        result.started = true;
      }
      else if(initialPhase!="running" && initialPhase!="starting") throw new InvalidOperationException("观战状态未确认；请打开控制台检查。");
      var elapsed = Stopwatch.StartNew();
      while (elapsed.Elapsed < TimeSpan.FromSeconds(40)) {
        result.phase = Convert.ToString(Json.Get(state,"phase"));
        result.pid = Json.Get(state,"pid") == null ? 0 : Convert.ToInt32(Json.Get(state,"pid"));
        if (result.pid > 0 && Json.IsTrue(Json.Get(state,"windowReady"))) {
          var focus = Task.Run(() => ObserverWindow.Show(result.pid));
          result.activated = await Task.WhenAny(focus,Task.Delay(5000)) == focus && await focus;
          return result;
        }
        if (result.phase == "failed" || result.phase == "error" || result.phase == "stopped")
          throw new InvalidOperationException(Convert.ToString(Json.Get(state,"detail")) ?? "观战客户端未启动，请查看日志。");
        await Task.Delay(600);
        state = await Api(cfg, route + "state", true, 8, args);
      }
      return result;
    }

    public static int Worker(Settings cfg) {
      bool created;
      using (var gate = new Mutex(true, "Local\\" + cfg.TaskName.Replace('\\','_') + ".Worker", out created)) {
        if (!created) return 0;
        try { return Work(cfg); } finally { gate.ReleaseMutex(); }
      }
    }
    private static int Work(Settings cfg) {
      var startedAt = DateTimeOffset.Now.ToString("o");
      var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss-fff");
      var stdout = Path.Combine(cfg.DataDir, stamp + ".stdout.log");
      var stderr = Path.Combine(cfg.DataDir, stamp + ".stderr.log");
      int supervisorPid = 0;
      try {
        var listener = System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners()
          .Any(p => p.Port == new Uri(cfg.ConsoleUrl).Port);
        if (listener) throw new InvalidOperationException("控制台端口已被占用；未启动第二份可米。请检查现有控制台。");
        if (!File.Exists(cfg.Node) || !File.Exists(Path.Combine(cfg.Root, cfg.Entry))) throw new FileNotFoundException("启动程序或 Cortico 入口不存在。");
        var info = new ProcessStartInfo(cfg.Node, Quote(cfg.Entry) + " " + Quote(cfg.Deployment)) {
          WorkingDirectory = cfg.Root, UseShellExecute = false, CreateNoWindow = true,
          RedirectStandardOutput = true, RedirectStandardError = true,
          StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        info.EnvironmentVariables["PATH"] = Path.GetDirectoryName(cfg.Node) + ";" + info.EnvironmentVariables["PATH"];
        info.EnvironmentVariables["CORTICO_START_PAUSED"] = cfg.StartPaused ? "1" : "0";
        info.EnvironmentVariables["CORTICO_OPEN_BROWSER"] = "0";
        using (var outFile = new StreamWriter(stdout, true, new UTF8Encoding(false)) { AutoFlush = true })
        using (var errFile = new StreamWriter(stderr, true, new UTF8Encoding(false)) { AutoFlush = true })
        using (var process = new Process { StartInfo = info }) {
          process.OutputDataReceived += (s,e) => { if (e.Data != null) outFile.WriteLine(e.Data); };
          process.ErrorDataReceived += (s,e) => { if (e.Data != null) errFile.WriteLine(e.Data); };
          process.Start(); supervisorPid = process.Id;
          process.BeginOutputReadLine(); process.BeginErrorReadLine();
          Json.Write(cfg.StatePath, new { state = "running", startedAt, workerPid = Process.GetCurrentProcess().Id,
            supervisorPid, supervisorStartedAt = process.StartTime.ToUniversalTime().ToString("o"), stdout, stderr });
          process.WaitForExit();
          Json.Write(cfg.StatePath, new { state = "exited", startedAt, exitedAt = DateTimeOffset.Now.ToString("o"),
            supervisorPid, exitCode = process.ExitCode, stdout, stderr });
          return process.ExitCode;
        }
      } catch (Exception e) {
        Json.Write(cfg.StatePath, new { state = "error", startedAt, exitedAt = DateTimeOffset.Now.ToString("o"),
          supervisorPid, error = e.Message, stdout, stderr });
        return 1;
      }
    }
  }

  public static class ObserverWindow {
    private delegate bool EnumProc(IntPtr hwnd, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int left,top,right,bottom; }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] private struct ProcessEntry {
      public uint size,usage,pid;
      public IntPtr heap;
      public uint module,threads,parent;
      public int priority;
      public uint flags;
      [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string file;
    }
    [DllImport("kernel32.dll",SetLastError=true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,EntryPoint="Process32FirstW")] private static extern bool ProcessFirst(IntPtr snapshot,ref ProcessEntry entry);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,EntryPoint="Process32NextW")] private static extern bool ProcessNext(IntPtr snapshot,ref ProcessEntry entry);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hwnd, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();

    public static bool Show(int ownerPid) {
      using (var owner = Process.GetProcessById(ownerPid)) {
        if (owner.HasExited) return false;
        var owners = new HashSet<int> { ownerPid };
        var parents = new Dictionary<int,int>();
        var snapshot = CreateToolhelp32Snapshot(2,0);
        if (snapshot == new IntPtr(-1)) return false;
        try {
          var entry = new ProcessEntry(); entry.size = (uint)Marshal.SizeOf(entry);
          if (ProcessFirst(snapshot,ref entry)) do { parents[(int)entry.pid]=(int)entry.parent; } while (ProcessNext(snapshot,ref entry));
          bool added;
          do {
            added = false;
            foreach (var process in parents) if (owners.Contains(process.Value) && owners.Add(process.Key)) added = true;
          } while (added);
        } finally { CloseHandle(snapshot); }
        IntPtr best = IntPtr.Zero; long bestArea = 0;
        EnumWindows((hwnd,data) => {
          uint pid; GetWindowThreadProcessId(hwnd,out pid);
          if (!owners.Contains((int)pid) || !IsWindowVisible(hwnd)) return true;
          Rect rect; if (!GetWindowRect(hwnd,out rect)) return true;
          long area = (long)(rect.right-rect.left)*(rect.bottom-rect.top);
          if (area > bestArea) { best = hwnd; bestArea = area; }
          return true;
        },IntPtr.Zero);
        if (best == IntPtr.Zero) return false;
        ShowWindowAsync(best,IsIconic(best)?9:5);
        SetForegroundWindow(best);
        var activation = Stopwatch.StartNew();
        while (GetForegroundWindow() != best && activation.ElapsedMilliseconds < 500)
          Thread.Sleep(25);
        return GetForegroundWindow() == best;
      }
    }
  }

  public sealed class LiveWindow : Form {
    private readonly Settings cfg;
    private Label heading, connection, game, voice, feedback;
    private Button start, pause, stop, observer;
    private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 2500 };
    private bool refreshing, busy, online, running, preview;
    private readonly Color accent = Color.FromArgb(224,112,53);
    public LiveWindow(Settings value) {
      cfg = value; Text = cfg.Title; BackColor = Color.FromArgb(250,247,242);
      Font = new Font("Microsoft YaHei UI", 10); ClientSize = new Size(730,410);
      MinimumSize = new Size(746,449); StartPosition = FormStartPosition.CenterScreen;
      AutoScaleMode = AutoScaleMode.Dpi;
      var iconPath = Path.Combine(Path.GetDirectoryName(cfg.ConfigPath), "CormyLive.ico");
      if (File.Exists(iconPath)) Icon = new Icon(iconPath);
      heading = LabelAt("可米直播", 30,23,660,40,23,FontStyle.Bold);
      LabelAt("千灯纪  ·  Minecraft 与演出",32,70,650,28,10,FontStyle.Regular).ForeColor = Color.FromArgb(108,99,88);
      connection = LabelAt("正在读取状态…",32,120,660,31,14,FontStyle.Bold);
      game = LabelAt("游戏连接：等待检查",32,163,660,27,10,FontStyle.Regular);
      voice = LabelAt("演出：等待检查",32,193,660,27,10,FontStyle.Regular);
      start = ButtonAt("启动可米",32,242,135,true,async () => {
        if (online) await Runtime.Api(cfg,"/api/run/resume",true,15);
        else Runtime.RunTask(cfg.TaskName);
        feedback.Text = online ? "已请求继续运行。" : "正在启动，可关闭此窗口。";
      });
      pause = ButtonAt("暂停思考",180,242,130,false,async () => {
        await Runtime.Api(cfg,"/api/run/pause",true,15); feedback.Text = "思考已暂停，连接保持。";
      });
      stop = ButtonAt("停止直播",323,242,130,false,async () => {
        if (MessageBox.Show(this,"停止可米并断开游戏？会话与记忆会保留。", "停止直播", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
        feedback.Text = "正在保存并停止，请稍候…";
        var result = await Runtime.Api(cfg,"/api/run/shutdown",true,60);
        if (!Json.IsTrue(Json.Get(result,"ok")) && !Json.IsTrue(Json.Get(result,"localComplete")))
          throw new InvalidOperationException("停止请求未确认完成，请查看控制台；不会强制结束进程。");
        feedback.Text = "停止请求已完成。";
      });
      ButtonAt("打开控制台",32,296,135,false,() => Open(cfg.ConsoleUrl));
      ButtonAt("打开游戏画面",180,296,150,false,() => Open(cfg.ViewerUrl));
      ButtonAt("查看日志",343,296,110,false,() => Open(cfg.DataDir));
      observer = ButtonAt("打开观战客户端",466,296,225,false,async () => {
        feedback.Text = "正在打开观战客户端…";
        var result = await Runtime.OpenObserver(cfg);
        feedback.Text = result.activated ? "观战客户端已打开。"
          : result.phase == "running" ? "观战客户端正在运行，可从任务栏切换到游戏窗口。"
          : "观战客户端正在启动，窗口就绪后可再次点击。";
      });
      feedback = LabelAt("关闭此窗口或 Codex 后，直播仍可继续；请用“停止直播”结束。",32,354,664,36,9,FontStyle.Regular);
      feedback.ForeColor = Color.FromArgb(108,99,88);
      timer.Tick += async (s,e) => await RefreshState();
      Shown += async (s,e) => { if(!preview) { timer.Start(); await RefreshState(); } };
      FormClosed += (s,e) => timer.Stop();
    }
    private Label LabelAt(string text,int x,int y,int width,int height,float size,FontStyle style) {
      var label = new Label { Text=text, Location=new Point(x,y), Size=new Size(width,height), Font=new Font("Microsoft YaHei UI",size,style), ForeColor=Color.FromArgb(43,45,44) };
      Controls.Add(label); return label;
    }
    private Button ButtonAt(string text,int x,int y,int width,bool primary,Func<Task> action) {
      var button = new Button { Text=text,Location=new Point(x,y),Size=new Size(width,39),FlatStyle=FlatStyle.Flat,
        BackColor=primary?accent:Color.White,ForeColor=primary?Color.White:Color.FromArgb(55,53,49),Cursor=Cursors.Hand };
      button.FlatAppearance.BorderColor=primary?accent:Color.FromArgb(221,214,204);
      button.Click += async (s,e) => {
        if(busy) return; busy=true; SetEnabled();
        try { await action(); } catch(Exception error) { feedback.Text=error.GetBaseException().Message; }
        finally { busy=false; }
        await RefreshState();
      };
      Controls.Add(button); return button;
    }
    private Task Open(string target) { Process.Start(new ProcessStartInfo(target) { UseShellExecute=true }); return Task.FromResult(0); }
    private void SetEnabled() { start.Enabled=!busy&&!running; pause.Enabled=!busy&&online&&running; stop.Enabled=!busy&&online; observer.Enabled=!busy&&online; }
    private async Task RefreshState() {
      if(refreshing || IsDisposed) return; refreshing=true;
      try {
        var status = await Runtime.Api(cfg,"/api/status");
        online=true; running=Json.IsTrue(Json.Get(status,"loop","running")) && !Json.IsTrue(Json.Get(status,"loop","paused"));
        connection.Text=running?"可米正在运行":"可米已启动 · 思考已暂停";
        connection.ForeColor=running?Color.FromArgb(44,128,83):Color.FromArgb(167,115,35);
        start.Text="继续运行";
        try {
          var worlds=await Runtime.Api(cfg,"/api/worlds");
          var list=Json.Get(worlds,"worlds") as object[];
          if(list != null) {
            game.Text="游戏连接："+WorldLabel(list,"mymc");
            voice.Text="演出："+WorldLabel(list,"vtuber");
          }
        } catch { game.Text="游戏连接：未验证"; voice.Text="演出：未验证"; }
      } catch {
        online=false; running=false; start.Text="启动可米";
        connection.Text="可米尚未启动"; connection.ForeColor=Color.FromArgb(110,102,92);
        game.Text="游戏连接：未连接"; voice.Text="演出：未连接";
        try {
          var state=Json.Read<Dictionary<string,object>>(cfg.StatePath);
          var phase=Convert.ToString(Json.Get(state,"state"));
          if(phase=="running") {
            var pid=Convert.ToInt32(Json.Get(state,"supervisorPid"));
            var proc=Process.GetProcessById(pid);
            var expected=DateTime.Parse(Convert.ToString(Json.Get(state,"supervisorStartedAt"))).ToUniversalTime();
            if(Math.Abs((proc.StartTime.ToUniversalTime()-expected).TotalSeconds)<1) connection.Text="正在启动或等待控制台响应…";
          } else if(phase=="error") connection.Text="启动失败，请查看日志";
        } catch { }
      } finally { refreshing=false; if(!IsDisposed) SetEnabled(); }
    }
    private static string WorldLabel(object[] worlds,string id) {
      var world=worlds.FirstOrDefault(w=>Convert.ToString(Json.Get(w,"id"))==id);
      if(world==null) return "未配置";
      if(Convert.ToString(Json.Get(world,"status"))!="active") return "未启用";
      var lamps=Json.Get(world,"lamps") as object[];
      if(lamps==null) return "已挂载，连接未验证";
      var server=lamps.FirstOrDefault(l=>Convert.ToString(Json.Get(l,"label"))=="服务器");
      if(id=="mymc" && server!=null) return "千灯纪 · "+Translate(Convert.ToString(Json.Get(server,"state")));
      return String.Join(" · ",lamps.Select(l=>Convert.ToString(Json.Get(l,"label"))+" "+Translate(Convert.ToString(Json.Get(l,"state")))));
    }
    private static string Translate(string value) { return value=="online"?"在线":value=="loading"?"连接中":value=="offline"?"离线":value; }
    public void Preview(string path) {
      preview=true; ShowInTaskbar=false; Opacity=0; Show(); Application.DoEvents();
      connection.Text="可米正在运行"; connection.ForeColor=Color.FromArgb(44,128,83);
      game.Text="游戏连接：千灯纪 · 在线"; voice.Text="演出：语音在线 · 画面在线";
      using(var bmp=new Bitmap(Width,Height)) { DrawToBitmap(bmp,new Rectangle(0,0,Width,Height)); bmp.Save(path); }
    }
  }

  public static class Program {
    [STAThread] public static int Main(string[] args) {
      var path=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"settings.json");
      int at=Array.IndexOf(args,"--config"); if(at>=0 && at+1<args.Length) path=args[at+1];
      try {
        var cfg=Settings.Load(path);
        if(args.Contains("--worker")) return Runtime.Worker(cfg);
        if(args.Contains("--start")) { Runtime.RunTask(cfg.TaskName); return 0; }
        if(args.Contains("--studio-open")) { Runtime.RunTask(cfg.TaskName+".Studio"); return 0; }
        if(args.Contains("--observer")) {
          var result = Runtime.OpenObserver(cfg).GetAwaiter().GetResult();
          Json.Write(Path.Combine(cfg.DataDir,"observer-open.json"),result);
          return result.activated ? 0 : 2;
        }
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        if(args.Contains("--studio")) {
          var studioPath=Path.Combine(Path.GetDirectoryName(cfg.ConfigPath),"studio.json");
          int option=Array.IndexOf(args,"--studio-config"); if(option>=0 && option+1<args.Length)studioPath=args[option+1];
          var settings=StudioSettings.Load(studioPath);
          at=Array.IndexOf(args,"--preview");
          if(at>=0 && at+1<args.Length) { using(var form=new StudioWindow(cfg,settings)) form.Preview(args[at+1]); return 0; }
          bool first;
          using(var gate=new Mutex(true,"Local\\"+cfg.TaskName+".Studio",out first)) {
            if(!first) { StudioWindow.FocusExisting(); return 0; }
            try { Application.Run(new StudioWindow(cfg,settings)); } finally { gate.ReleaseMutex(); }
          }
          return 0;
        }
        at=Array.IndexOf(args,"--preview");
        if(at>=0 && at+1<args.Length) { using(var form=new LiveWindow(cfg)) form.Preview(args[at+1]); return 0; }
        if(!args.Contains("--ui")) { Runtime.RunTask(cfg.TaskName+".Panel"); return 0; }
        bool created;
        using(var gate=new Mutex(true,"Local\\"+cfg.TaskName+".Panel",out created)) {
          if(!created) return 0;
          try { Application.Run(new LiveWindow(cfg)); } finally { gate.ReleaseMutex(); }
        }
        return 0;
      } catch(Exception error) {
        if(args.Contains("--worker")) return 1;
        if(args.Contains("--start") || args.Contains("--observer")) { File.WriteAllText(path+".start-error.log",error.GetBaseException().Message); return 1; }
        MessageBox.Show(error.GetBaseException().Message,"可米直播",MessageBoxButtons.OK,MessageBoxIcon.Error); return 1;
      }
    }
  }
}
