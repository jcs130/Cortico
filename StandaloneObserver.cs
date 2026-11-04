using System;
using System.Diagnostics;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Management;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace CormyLive {
  // An explicitly installed mc-visual-console observer. It is independent of a
  // game World's personal eye; a failure never falls back to World client.start.
  public sealed class ObserverArtifact {
    public string RelativePath, Sha256;
  }
  public sealed class StandaloneObserverSettings {
    public string ProfileDirectory, LauncherExecutable, LauncherScript, SelectorFile;
    public string ExpectedAccount, ExpectedServer, ExpectedUuid, ExpectedLoader;
    public string ExpectedJavaExecutable, NativeVersion, ObserverVersion;
    public ObserverArtifact[] Artifacts;
    public static bool SamePath(string a,string b) {
      return !String.IsNullOrWhiteSpace(a)&&!String.IsNullOrWhiteSpace(b)
        &&String.Equals(Path.GetFullPath(a).TrimEnd('\\','/'),Path.GetFullPath(b).TrimEnd('\\','/'),StringComparison.OrdinalIgnoreCase);
    }
    public void Validate() {
      foreach(var p in new[]{ProfileDirectory,LauncherExecutable,LauncherScript,ExpectedJavaExecutable})
        if(String.IsNullOrWhiteSpace(p)||!Path.IsPathRooted(p))throw new InvalidDataException("独立观战入口需要绝对路径。");
      if(!String.IsNullOrWhiteSpace(SelectorFile)&&!Path.IsPathRooted(SelectorFile))throw new InvalidDataException("观战选择文件需要绝对路径。");
      foreach(var s in new[]{ExpectedAccount,ExpectedServer,ExpectedUuid,ExpectedLoader,NativeVersion,ObserverVersion})
        if(String.IsNullOrWhiteSpace(s))throw new InvalidDataException("独立观战配置缺少身份或发行版本。");
      Guid uuid;if(!Guid.TryParse(ExpectedUuid,out uuid))throw new InvalidDataException("观战 UUID 无效。");
      if(Artifacts==null||Artifacts.Length==0)throw new InvalidDataException("独立观战需要已验收发行包的校验值。");
      foreach(var a in Artifacts)ArtifactPath(a);
    }
    public string ArtifactPath(ObserverArtifact a) {
      if(a==null||String.IsNullOrWhiteSpace(a.RelativePath)||Path.IsPathRooted(a.RelativePath)
        ||String.IsNullOrWhiteSpace(a.Sha256)||!Regex.IsMatch(a.Sha256,"\\A[0-9a-fA-F]{64}\\z"))throw new InvalidDataException("观战发行包清单无效。");
      var root=Path.GetFullPath(ProfileDirectory).TrimEnd('\\','/')+Path.DirectorySeparatorChar;
      var path=Path.GetFullPath(Path.Combine(root,a.RelativePath));
      if(!path.StartsWith(root,StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("观战发行包超出实例目录。");
      return path;
    }
    public void CheckSelection() {
      if(String.IsNullOrWhiteSpace(SelectorFile))return;
      var selected=Convert.ToString(Json.Get(Json.Read<object>(SelectorFile),"profile"));
      if(String.IsNullOrWhiteSpace(selected)||!SamePath(Path.Combine(Path.GetDirectoryName(SelectorFile),selected),ProfileDirectory))
        throw new InvalidDataException("观战启动器选择了其他实例，请核对配置；没有回退到旧客户端。");
    }
    public void VerifyDeployment() {
      Validate();CheckSelection();
      if(!Directory.Exists(ProfileDirectory)||!File.Exists(LauncherExecutable)||!File.Exists(LauncherScript)||!File.Exists(ExpectedJavaExecutable))
        throw new FileNotFoundException("已配置的独立观战程序不完整。");
      foreach(var a in Artifacts)using(var input=File.OpenRead(ArtifactPath(a)))using(var hash=SHA256.Create()) {
        var actual=BitConverter.ToString(hash.ComputeHash(input)).Replace("-","");
        if(!String.Equals(actual,a.Sha256,StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("观战发行包校验不符，请更新入口清单后再打开。");
      }
    }
  }

  public sealed class ObserverProcessIdentity {
    public bool Exists;
    public string Executable, ProfileDirectory, Account;
    public DateTimeOffset StartedAt;
  }
  public sealed class StandaloneObserverState {
    public string Phase="unconfirmed",Label="独立观战状态未确认",Detail;
    public int Pid;
    public bool Ready,Connected,Attached;
  }
  public sealed class BroadcastPlayer {
    public string Name,Uuid;
    public override string ToString(){return Name;}
  }
  public sealed class BroadcastState {
    public bool Enabled;
    public string Label="等待导播状态",Mode="auto",TargetUuid,TargetName,SelectionId;
    public List<BroadcastPlayer> Players=new List<BroadcastPlayer>();
  }
  public sealed class StandaloneObserver {
    readonly StandaloneObserverSettings settings;
    readonly Func<int,ObserverProcessIdentity> inspect;
    readonly Func<Task<int>> launch;
    readonly Func<int,bool> focus;
    readonly Func<int,Task> delay;
    readonly int attempts;
    readonly SemaphoreSlim gate=new SemaphoreSlim(1,1);
    public StandaloneObserver(StandaloneObserverSettings value):this(value,ReadProcess,()=>Launch(value),ObserverWindow.Show,Task.Delay,60){}
    // Injectable OS boundary permits offline checks without touching a game or window.
    public StandaloneObserver(StandaloneObserverSettings value,Func<int,ObserverProcessIdentity> process,
      Func<Task<int>> start,Func<int,bool> activate,Func<int,Task> wait,int polls) {
      value.Validate();settings=value;inspect=process;launch=start;focus=activate;delay=wait;attempts=Math.Max(1,polls);
    }
    static string Arg(string command,string name) {
      var match=Regex.Match(command??"","(?:^|\\s)"+Regex.Escape(name)+"\\s+(?:\"([^\"]*)\"|(\\S+))");
      return match.Success?(match.Groups[1].Success?match.Groups[1].Value:match.Groups[2].Value):null;
    }
    static ObserverProcessIdentity ReadProcess(int pid) {
      if(pid<=0)return new ObserverProcessIdentity();
      using(var query=new ManagementObjectSearcher("SELECT ExecutablePath,CreationDate,CommandLine FROM Win32_Process WHERE ProcessId="+pid)) {
        query.Options.Timeout=TimeSpan.FromSeconds(3);
        using(var rows=query.Get())foreach(ManagementObject row in rows)using(row) {
          var command=Convert.ToString(row["CommandLine"]);
          return new ObserverProcessIdentity {Exists=true,Executable=Convert.ToString(row["ExecutablePath"]),
            ProfileDirectory=Arg(command,"--gameDir"),Account=Arg(command,"--username"),
            StartedAt=new DateTimeOffset(ManagementDateTimeConverter.ToDateTime(Convert.ToString(row["CreationDate"])))};
        }
      }
      return new ObserverProcessIdentity();
    }
    static async Task<int> Launch(StandaloneObserverSettings value) {
      using(var process=new Process {StartInfo=new ProcessStartInfo(value.LauncherExecutable,Runtime.Quote(value.LauncherScript)) {
        WorkingDirectory=Path.GetDirectoryName(value.LauncherScript),UseShellExecute=false,CreateNoWindow=true,
        RedirectStandardOutput=true,RedirectStandardError=true
      }}) {
        process.Start();
        // Do not expose launcher output: deployment scripts may contain private metadata.
        var output=process.StandardOutput.ReadToEndAsync();var error=process.StandardError.ReadToEndAsync();
        await Task.Run(()=>process.WaitForExit());await Task.WhenAll(output,error);return process.ExitCode;
      }
    }
    object Read(string relative){return Json.Read<object>(Path.Combine(settings.ProfileDirectory,relative));}
    static string Text(object data,string key){return Convert.ToString(Json.Get(data,key));}
    static bool Fresh(object data,DateTimeOffset startedAt) {
      DateTimeOffset at;if(!DateTimeOffset.TryParse(Text(data,"recordedAt"),out at))return false;
      return at>=startedAt&&at>=DateTimeOffset.UtcNow.AddSeconds(-15)&&at<=DateTimeOffset.UtcNow.AddSeconds(5);
    }
    public StandaloneObserverState Probe() {
      var state=new StandaloneObserverState();
      try {
        settings.CheckSelection();
        var record=Read("process.json");
        if(!StandaloneObserverSettings.SamePath(Text(record,"profile"),settings.ProfileDirectory)
          ||Text(record,"account")!=settings.ExpectedAccount||Text(record,"destination")!=settings.ExpectedServer
          ||Text(record,"loader")!=settings.ExpectedLoader
          ||!StandaloneObserverSettings.SamePath(Text(record,"javaPath"),settings.ExpectedJavaExecutable))throw new InvalidDataException("观战启动记录与已选实例不符。");
        state.Pid=Convert.ToInt32(Json.Get(record,"pid"));
        var process=inspect(state.Pid);
        if(!process.Exists){state.Phase="stopped";state.Label=settings.ExpectedAccount+" · 已停止 · 点击打开独立观战";return state;}
        DateTimeOffset launched;
        if(!DateTimeOffset.TryParse(Text(record,"at"),out launched)||Math.Abs((process.StartedAt-launched).TotalSeconds)>20
          ||!StandaloneObserverSettings.SamePath(process.Executable,settings.ExpectedJavaExecutable)
          ||!StandaloneObserverSettings.SamePath(process.ProfileDirectory,settings.ProfileDirectory)||process.Account!=settings.ExpectedAccount)
          throw new InvalidDataException("观战 PID 已变化或属于其他实例，未切换窗口。");
        state.Phase="starting";state.Label=settings.ExpectedAccount+" · 进程存在 · 等待新状态";
        var window=Read("diagnostics/mcvisual-native-window.json");
        var native=Read("diagnostics/mcvisual-native-director.json");
        var observer=Read("diagnostics/mcvisual-native-observer.json");
        if(!Fresh(window,process.StartedAt)||!Fresh(native,process.StartedAt)||!Fresh(observer,process.StartedAt))return state;
        if(Text(window,"schema")!="mcvisual.native-window/v1"||Text(native,"schema")!="mcvisual-native-director/v1"
          ||Text(observer,"schema")!="mcvisual-native-observer/v1"||Convert.ToInt32(Json.Get(window,"processId"))!=state.Pid
          ||!settings.ExpectedLoader.StartsWith(Text(window,"loader")+"-",StringComparison.Ordinal)
          ||Text(native,"nativeVersion")!=settings.NativeVersion||Text(observer,"nativeVersion")!=settings.ObserverVersion)
          throw new InvalidDataException("运行中的观战版本未通过核对，未切换窗口。");
        state.Connected=Json.IsTrue(Json.Get(native,"connected"));
        if(state.Connected&&(Text(native,"observer")!=settings.ExpectedAccount||Text(native,"server")!=settings.ExpectedServer
          ||!String.Equals(Text(native,"observerUuid"),settings.ExpectedUuid,StringComparison.OrdinalIgnoreCase)))
          throw new InvalidDataException("观战实际登录身份或服务器不匹配。");
        state.Attached=state.Connected&&Json.IsTrue(Json.Get(native,"authenticated"))&&Text(native,"phase")=="attached"
          &&!String.IsNullOrEmpty(Text(native,"targetUuid"))&&Text(native,"targetUuid")==Text(native,"cameraUuid");
        state.Ready=true;state.Phase="running";
        state.Label=settings.ExpectedAccount+" · "+Text(window,"loader")+" · "+settings.NativeVersion+" · "+(state.Attached?"跟拍中":state.Connected?"已连接":"未连线");
      }catch(Exception error){state.Detail=error.GetBaseException().Message;if(error is InvalidDataException||state.Phase!="starting")state.Phase="unconfirmed";state.Ready=false;state.Label=settings.ExpectedAccount+" · 状态未确认";}
      return state;
    }
    public BroadcastState Broadcast() {
      var result=new BroadcastState();
      try {
        var state=Probe();if(!state.Ready||!state.Connected){result.Label=state.Label;return result;}
        var native=Read("diagnostics/mcvisual-native-director.json");
        if(!Json.IsTrue(Json.Get(native,"authenticated")))return result;
        // The producer uses this profile-local status; never accept another instance's roster.
        var manager=Read("diagnostics/smart-director-status.json");
        DateTimeOffset at;
        if(!DateTimeOffset.TryParse(Text(manager,"at"),out at)||at<DateTimeOffset.UtcNow.AddSeconds(-8)||at>DateTimeOffset.UtcNow.AddSeconds(5)
          ||!Json.IsTrue(Json.Get(manager,"running"))||!Json.IsTrue(Json.Get(manager,"capabilities","operatorSelection"))
          ||Text(manager,"connectionEpoch")!=Text(native,"connectionEpoch")){result.Label="导播尚未就绪 · 暂不能选人";return result;}
        var players=Json.Get(native,"targets") as IEnumerable;
        var ids=new HashSet<string>(StringComparer.OrdinalIgnoreCase);var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if(players==null)return result;
        foreach(var p in players) {
          string name=Text(p,"name"),id=Text(p,"uuid");Guid parsed;
          if(result.Players.Count>=256||!Regex.IsMatch(name??"","\\A[A-Za-z0-9_]{1,16}\\z")||!Guid.TryParse(id,out parsed)
            ||!ids.Add(id)||!names.Add(name)||String.Equals(id,settings.ExpectedUuid,StringComparison.OrdinalIgnoreCase)
            ||!(Json.Get(p,"spectator") is bool)||Json.IsTrue(Json.Get(p,"spectator")))throw new InvalidDataException("观战玩家列表无效。");
          if(Json.Get(p,"alive") is bool&&!Json.IsTrue(Json.Get(p,"alive")))continue;
          result.Players.Add(new BroadcastPlayer {Name=name,Uuid=id});
        }
        var selection=Json.Get(manager,"operatorSelection");result.Mode=Text(selection,"mode");
        result.TargetUuid=Convert.ToString(Json.Get(selection,"target","uuid"));result.SelectionId=Text(selection,"id");
        result.TargetName=Convert.ToString(Json.Get(selection,"target","name"));
        result.Enabled=true;
        string actual=state.Attached?Text(native,"target"):"等待画面";
        result.Label="当前："+actual;
        if(Text(selection,"state")=="waiting_target")result.Label="等待："+Convert.ToString(Json.Get(selection,"target","name"))+"上线";
        else if(result.Mode=="invalid")result.Label="选人配置无效 · 请重新选择";
        else if(result.Mode=="follow"&&!String.Equals(result.TargetUuid,Text(native,"cameraUuid"),StringComparison.OrdinalIgnoreCase))result.Label+=" · 等待切换";
      }catch(Exception error){result.Enabled=false;result.Label=error is InvalidDataException?error.Message:"导播状态暂未确认";}
      return result;
    }
    public string SelectBroadcast(string mode,string targetUuid) {
      var state=Broadcast();if(!state.Enabled)throw new InvalidOperationException(state.Label);
      if(mode!="auto"&&mode!="follow")throw new InvalidDataException("未知的观战模式。");
      BroadcastPlayer player=null;
      if(mode=="follow") {
        player=state.Players.Find(p=>String.Equals(p.Uuid,targetUuid,StringComparison.OrdinalIgnoreCase));
        if(player==null)throw new InvalidOperationException("玩家当前不在观战列表，请刷新后选择。");
      }
      var id=Guid.NewGuid().ToString();
      Json.Write(Path.Combine(settings.ProfileDirectory,"config/mcvisual-broadcast-selection.json"),new {
        schema="mcvisual.broadcast-selection/v1",id,mode,target=player==null?null:new{name=player.Name,uuid=player.Uuid},
        scope=new{server=settings.ExpectedServer,observerUuid=settings.ExpectedUuid},updatedAt=DateTimeOffset.UtcNow.ToString("o")});
      return id;
    }
    public async Task<Runtime.ObserverOpenResult> Open() {
      await gate.WaitAsync();
      try {
        settings.VerifyDeployment();
        var state=Probe();var result=new Runtime.ObserverOpenResult();Task<int> helper=null;
        if(state.Phase=="stopped"){helper=launch();result.started=true;}
        else if(state.Phase=="unconfirmed")throw new InvalidOperationException(state.Detail??state.Label);
        for(int i=0;i<attempts;i++) {
          state=Probe();result.pid=state.Pid;result.phase=state.Phase;
          if(state.Ready) {
            result.activated=await Task.Run(()=>{var latest=Probe();return latest.Ready&&latest.Pid==state.Pid&&focus(latest.Pid);});
            return result;
          }
          if(state.Phase=="unconfirmed")throw new InvalidOperationException(state.Detail??state.Label);
          if(helper!=null&&helper.IsCompleted&&await helper!=0)throw new InvalidOperationException("独立观战启动器未成功，请检查实例日志；未改用旧客户端。");
          if(helper==null&&state.Phase=="stopped")throw new InvalidOperationException("观战进程已退出，未自动重启。");
          await delay(1000);
        }
        // RPC/helper acceptance is not a running window or a successful connection.
        result.phase="starting";return result;
      }finally{gate.Release();}
    }
  }
}
