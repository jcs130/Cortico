using System;
using System.IO;
using System.Security.Cryptography;
using System.Threading.Tasks;
using CormyLive;

static class StandaloneTests {
  static int checks;
  static void Check(bool ok,string name){if(!ok)throw new Exception(name);checks++;Console.WriteLine("PASS "+name);}
  sealed class Fixture : IDisposable {
    public string Root=Path.Combine(Path.GetTempPath(),"observer-fixture-"+Guid.NewGuid().ToString("N"));
    public StandaloneObserverSettings Config;
    public ObserverProcessIdentity Process;
    public DateTimeOffset Started=DateTimeOffset.UtcNow.AddSeconds(-5);
    public int Launches,Focuses;
    public Action OnLaunch;
    public StandaloneObserver Adapter;
    public Fixture() {
      Directory.CreateDirectory(Root);
      string script=Path.Combine(Root,"launcher.mjs"),node=Path.Combine(Root,"node.exe"),java=Path.Combine(Root,"javaw.exe"),jar=Path.Combine(Root,"fixture.jar");
      foreach(var p in new[]{script,node,java,jar})File.WriteAllText(p,"fixture-not-executable");
      string digest;using(var hash=SHA256.Create())digest=BitConverter.ToString(hash.ComputeHash(File.ReadAllBytes(jar))).Replace("-","");
      Config=new StandaloneObserverSettings {ProfileDirectory=Root,LauncherExecutable=node,LauncherScript=script,ExpectedJavaExecutable=java,
        ExpectedAccount="live-fixture",ExpectedServer="localhost:25577",ExpectedUuid="11111111-2222-3333-4444-555555555555",ExpectedLoader="neoforge-21.1.test",
        NativeVersion="0.test",ObserverVersion="1.test",SelectorFile=Path.Combine(Root,"selector.json"),
        Artifacts=new[]{new ObserverArtifact {RelativePath="fixture.jar",Sha256=digest}}};
      Json.Write(Config.SelectorFile,new{profile="."});
      Process=new ObserverProcessIdentity {Exists=true,Executable=java,ProfileDirectory=Root,Account=Config.ExpectedAccount,StartedAt=Started};
      Record();Frames(DateTimeOffset.UtcNow);
      Adapter=new StandaloneObserver(Config,pid=>Process,()=>{Launches++;if(OnLaunch!=null)OnLaunch();return Task.FromResult(0);},pid=>{Focuses++;return true;},ms=>Task.FromResult(0),2);
    }
    public void Record(){Json.Write(Path.Combine(Root,"process.json"),new{pid=123,profile=Root,account=Config.ExpectedAccount,destination=Config.ExpectedServer,loader=Config.ExpectedLoader,javaPath=Config.ExpectedJavaExecutable,at=Started.ToString("o")});}
    public void Frames(DateTimeOffset at,string version=null,int pid=123,string account=null,string server=null) {
      Json.Write(Path.Combine(Root,"diagnostics/mcvisual-native-window.json"),new{schema="mcvisual.native-window/v1",processId=pid,loader="neoforge",recordedAt=at.ToString("o")});
      Json.Write(Path.Combine(Root,"diagnostics/mcvisual-native-director.json"),new{schema="mcvisual-native-director/v1",recordedAt=at.ToString("o"),nativeVersion=version??Config.NativeVersion,
        connected=true,authenticated=true,phase="attached",observer=account??Config.ExpectedAccount,server=server??Config.ExpectedServer,observerUuid=Config.ExpectedUuid,targetUuid="target",cameraUuid="target"});
      Json.Write(Path.Combine(Root,"diagnostics/mcvisual-native-observer.json"),new{schema="mcvisual-native-observer/v1",recordedAt=at.ToString("o"),nativeVersion=Config.ObserverVersion});
    }
    public void BroadcastFrames(bool enabled=true) {
      var at=DateTimeOffset.UtcNow.ToString("o");
      Json.Write(Path.Combine(Root,"diagnostics/mcvisual-native-director.json"),new{schema="mcvisual-native-director/v1",recordedAt=at,nativeVersion=Config.NativeVersion,
        connected=true,authenticated=true,phase="attached",observer=Config.ExpectedAccount,server=Config.ExpectedServer,observerUuid=Config.ExpectedUuid,
        connectionEpoch="fixture-epoch",target="Alice",targetUuid="22222222-2222-3333-4444-555555555555",cameraUuid="22222222-2222-3333-4444-555555555555",
        targets=new[]{new{name="Alice",uuid="22222222-2222-3333-4444-555555555555",spectator=false},new{name="Bob",uuid="33333333-2222-3333-4444-555555555555",spectator=false}}});
      Json.Write(Path.Combine(Root,"diagnostics/smart-director-status.json"),new{at,running=true,connectionEpoch="fixture-epoch",capabilities=new{operatorSelection=enabled},operatorSelection=new{mode="auto",state="ready"}});
    }
    public void Dispose(){Directory.Delete(Root,true);}
  }
  static void Rejected(Fixture f,string name) {
    bool failed=false;try{f.Adapter.Open().GetAwaiter().GetResult();}catch(Exception){failed=true;}
    Check(failed&&f.Launches==0&&f.Focuses==0,name);
  }
  static int Main(string[] args) {try {
    if(args.Length==2&&args[0]=="--probe-studio") {
      var cfg=StudioSettings.Load(args[1]);cfg.Observer.VerifyDeployment();
      Console.WriteLine(Json.Serializer().Serialize(new StandaloneObserver(cfg.Observer).Probe()));return 0;
    }
    using(var f=new Fixture()) {
      var state=f.Adapter.Probe();Check(state.Ready&&state.Attached&&state.Pid==123,"fresh matching process and native frames confirm attached");
      var result=f.Adapter.Open().GetAwaiter().GetResult();
      Check(result.activated&&!result.started&&f.Launches==0&&f.Focuses==1,"existing verified client is reused without a launch");
    }
    using(var f=new Fixture()) {f.Process.Exists=false;Check(f.Adapter.Probe().Phase=="stopped","dead process overrides an old running record");
      f.OnLaunch=()=>f.Process.Exists=true;Task.WhenAll(f.Adapter.Open(),f.Adapter.Open()).GetAwaiter().GetResult();
      Check(f.Launches==1&&f.Focuses==2,"two opens share one launch and the same process");}
    using(var f=new Fixture()) {f.Process.StartedAt=DateTimeOffset.UtcNow.AddHours(-1);Rejected(f,"reused PID cannot be activated or restarted");}
    using(var f=new Fixture()) {f.Process.ProfileDirectory=Path.Combine(f.Root,"old-eye");Rejected(f,"same Java executable with wrong game directory is rejected");}
    using(var f=new Fixture()) {f.Process.Account="eye";Rejected(f,"personal eye account is rejected");}
    using(var f=new Fixture()) {f.Process.Executable=Path.Combine(f.Root,"wrong-java.exe");Rejected(f,"different Java runtime is rejected");}
    using(var f=new Fixture()) {f.Frames(DateTimeOffset.UtcNow.AddMinutes(-2));var r=f.Adapter.Open().GetAwaiter().GetResult();Check(!r.activated&&r.phase=="starting"&&f.Launches==0,"stale native frames do not confirm or duplicate a running client");}
    using(var f=new Fixture()) {f.Frames(DateTimeOffset.UtcNow.AddMinutes(1));Check(!f.Adapter.Probe().Ready,"future frame timestamp cannot confirm ready");}
    using(var f=new Fixture()) {f.Frames(DateTimeOffset.UtcNow,"old-version");Rejected(f,"wrong loaded native version cannot focus");}
    using(var f=new Fixture()) {f.Frames(DateTimeOffset.UtcNow,null,456);Rejected(f,"window PID mismatch cannot focus");}
    using(var f=new Fixture()) {f.Frames(DateTimeOffset.UtcNow,null,123,"eye");Rejected(f,"actual login account mismatch is rejected");}
    using(var f=new Fixture()) {f.Frames(DateTimeOffset.UtcNow,null,123,null,"other-server");Rejected(f,"actual server mismatch is rejected");}
    using(var f=new Fixture()) {Json.Write(f.Config.SelectorFile,new{profile="old-fabric"});Rejected(f,"changed launcher selection fails closed");}
    using(var f=new Fixture()) {File.WriteAllText(Path.Combine(f.Root,"fixture.jar"),"replacement");Rejected(f,"changed release artifact must be explicitly reviewed");}
    using(var f=new Fixture()) {f.Config.Artifacts[0].RelativePath="../outside.jar";Rejected(f,"release manifest cannot escape its instance");}
    using(var f=new Fixture()) {File.WriteAllText(Path.Combine(f.Root,"process.json"),"broken");Rejected(f,"unreadable launch record does not start or focus another client");}
    using(var f=new Fixture()) {f.Process.Exists=false;var r=f.Adapter.Open().GetAwaiter().GetResult();Check(r.started&&!r.activated&&r.phase=="starting","accepted launcher exit is not client completion");}
    using(var f=new Fixture()) {f.Process.Exists=false;f.Adapter=new StandaloneObserver(f.Config,p=>f.Process,()=>Task.FromResult(1),p=>{f.Focuses++;return true;},ms=>Task.FromResult(0),1);Rejected(f,"failed launcher cannot report completion or use World fallback");}
    using(var f=new Fixture()) {
      f.BroadcastFrames();var view=f.Adapter.Broadcast();Check(view.Enabled&&view.Players.Count==2&&view.Label=="当前：Alice","native roster and actual attached target exposed");
      var id=f.Adapter.SelectBroadcast("follow",view.Players[1].Uuid);var file=Path.Combine(f.Root,"config/mcvisual-broadcast-selection.json");
      var choice=Json.Read<object>(file);Check(Convert.ToString(Json.Get(choice,"id"))==id&&Convert.ToString(Json.Get(choice,"target","name"))=="Bob","manual choice binds exact native player UUID");
      Check(Convert.ToString(Json.Get(choice,"scope","observerUuid"))==f.Config.ExpectedUuid&&f.Launches==0&&f.Focuses==0,"selection preserves observer scope without game or window launch");
      bool failed=false;try{f.Adapter.SelectBroadcast("follow","unknown");}catch(InvalidOperationException){failed=true;}
      Check(failed&&Convert.ToString(Json.Get(Json.Read<object>(file),"id"))==id,"unknown player cannot overwrite selection");
      f.Adapter.SelectBroadcast("auto",null);Check(Convert.ToString(Json.Get(Json.Read<object>(file),"mode"))=="auto","automatic mode can be restored");
      f.BroadcastFrames(false);Check(!f.Adapter.Broadcast().Enabled,"old director cannot pretend to support selection");
      f.Frames(DateTimeOffset.UtcNow.AddMinutes(-1));Check(!f.Adapter.Broadcast().Enabled,"stale native telemetry cannot authorize selection");
    }
    Console.WriteLine(checks+" checks passed; fixture only, no real process launch, game, host, or window control.");return 0;
  }catch(Exception e){Console.Error.WriteLine(e);return 1;}}
}
