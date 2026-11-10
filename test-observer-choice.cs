using System;using System.IO;using CormyLive;
static class ObserverChoiceTests {
 static int checks;static void Check(bool ok,string name){if(!ok)throw new Exception(name);checks++;Console.WriteLine("PASS "+name);}
 static StandaloneObserverSettings Spec(string root,string name,string uuid){return new StandaloneObserverSettings{ProfileDirectory=Path.Combine(root,name),LauncherExecutable=Path.Combine(root,"node.exe"),LauncherScript=Path.Combine(root,name+".mjs"),ExpectedJavaExecutable=Path.Combine(root,"javaw.exe"),ExpectedAccount=name,ExpectedUuid=uuid,ExpectedServer="fixture.invalid:25577",ExpectedLoader="neoforge-fixture",NativeVersion="fixture",ObserverVersion="fixture",Artifacts=new[]{new ObserverArtifact{RelativePath="mods/fixture.jar",Sha256=new String('a',64)}}};}
 public static int Main(){try{
  var root=Path.Combine(Path.GetTempPath(),"studio-choice-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
  var eye=Spec(root,"eye-fixture","11111111-2222-3333-4444-555555555555");var live=Spec(root,"live-fixture","aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  var choices=new[]{new StudioObserverChoice{Id="eye",Label="Personal",Observer=eye},new StudioObserverChoice{Id="live",Label="Broadcast",Observer=live}};
  var settings=new StudioSettings{AvatarUrl="http://127.0.0.1:18501/",AvatarExecutable=Path.Combine(root,"app.exe"),AvatarApp=root,AvatarStatusFile=Path.Combine(root,"status.json"),StateFile=Path.Combine(root,"window.json"),Observers=choices,SelectedObserverId="eye"};
  var file=Path.Combine(root,"settings.json");Json.Write(file,settings);var loaded=StudioSettings.Load(file);
  Check(loaded.Observer.ExpectedAccount=="eye-fixture","default selects exact personal account");
  loaded.SelectObserver("live");Check(loaded.Observer.ExpectedAccount=="live-fixture"&&loaded.Observer.ExpectedUuid==live.ExpectedUuid,"live uses its own complete identity");
  loaded.SelectObserver("eye");Check(loaded.Observer.ProfileDirectory==eye.ProfileDirectory&&loaded.Observer.LauncherScript==eye.LauncherScript,"switch back does not retain another launch target");
  bool rejected=false;try{loaded.SelectObserver("unknown");}catch(InvalidDataException){rejected=true;}
  Check(rejected&&loaded.SelectedObserverId=="eye"&&loaded.Observer.ExpectedAccount=="eye-fixture","invalid choice keeps previous binding");
  Check(!File.Exists(eye.LauncherScript)&&!File.Exists(live.LauncherScript),"selection never launches either observer");
  settings.Observers[1].Id="eye";Json.Write(file,settings);rejected=false;try{StudioSettings.Load(file);}catch(InvalidDataException){rejected=true;}Check(rejected,"duplicate IDs are rejected before binding");
  settings.Observers=null;settings.Observer=live;Json.Write(file,settings);loaded=StudioSettings.Load(file);Check(loaded.Observer.ExpectedAccount=="live-fixture","legacy single-profile settings still work");
  Console.WriteLine(checks+" observer-choice checks passed");return 0;
 }catch(Exception error){Console.Error.WriteLine(error);return 1;}}
}
