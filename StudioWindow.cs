using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CormyLive {
  public sealed class StudioSettings {
    public string AvatarExecutable, AvatarApp, AvatarStatusFile, AvatarUrl, StateFile;
    public string PrimaryTargetName;
    public StandaloneObserverSettings Observer;
    public static StudioSettings Load(string path) {
      var value=Json.Read<StudioSettings>(path);
      LocalUrl(value.AvatarUrl);
      foreach(var file in new[]{value.AvatarExecutable,value.AvatarApp,value.AvatarStatusFile,value.StateFile})
        if(String.IsNullOrWhiteSpace(file)||!Path.IsPathRooted(file))throw new InvalidDataException("直播小助手需要绝对路径配置。");
      if(value.Observer!=null)value.Observer.Validate();
      return value;
    }
    public static string LocalUrl(string text) {
      Uri url;
      if(!Uri.TryCreate(text,UriKind.Absolute,out url)||url.Scheme!="http"||!url.IsLoopback||!String.IsNullOrEmpty(url.UserInfo))
        throw new InvalidDataException("展示入口必须是本机 HTTP 地址。");
      return url.AbsoluteUri;
    }
    public void OpenAvatar() {
      if(!File.Exists(AvatarExecutable)||!File.Exists(Path.Combine(AvatarApp,"package.json")))
        throw new FileNotFoundException("没有找到已安装的透明形象窗口，请检查小助手配置。");
      Process.Start(new ProcessStartInfo(AvatarExecutable,Runtime.Quote(AvatarApp)) {
        WorkingDirectory=AvatarApp,UseShellExecute=false,CreateNoWindow=true
      }); // The existing renderer owns its single-instance lock and silent output.
    }
    public string AvatarLabel() {
      try {
        var data=Json.Read<object>(AvatarStatusFile);
        var observed=DateTimeOffset.Parse(Convert.ToString(Json.Get(data,"at")));
        if(DateTimeOffset.UtcNow-observed>TimeSpan.FromSeconds(15)||observed>DateTimeOffset.UtcNow.AddSeconds(5))return "窗口未打开 · 点击即可显示";
        using(var proc=Process.GetProcessById(Convert.ToInt32(Json.Get(data,"pid")))) {
          if(proc.HasExited||!String.Equals(Path.GetFullPath(proc.MainModule.FileName),Path.GetFullPath(AvatarExecutable),StringComparison.OrdinalIgnoreCase))return "窗口状态未确认";
        }
        if(!Json.IsTrue(Json.Get(data,"presentation","loaded")))return "窗口已打开 · 画面加载中";
        if(Json.IsTrue(Json.Get(data,"minimized")))return "窗口已最小化 · 请显示以便采集";
        return Json.IsTrue(Json.Get(data,"visible"))?"透明窗口已显示 · 独立字幕":"窗口已隐藏 · 点击即可显示";
      } catch { return "窗口状态未确认 · 可点击显示"; }
    }
  }

  public sealed class StudioWindow : Form {
    public const string WindowTitle="可米 · 直播小助手";
    private readonly Settings host;
    private readonly StudioSettings settings;
    private readonly StandaloneObserver standalone;
    private readonly System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer { Interval=4000 };
    private readonly Color ink=Color.FromArgb(233,238,246),muted=Color.FromArgb(155,169,189),accent=Color.FromArgb(111,213,190);
    private Label status,gameState,avatarState,feedback,broadcastLabel;
    private Button observer,web,avatar;
    private Button applyTarget;
    private ComboBox broadcastMode,players;
    private BroadcastState broadcast;
    private bool selectionInitialized,selectionDirty,updatingSelection;
    private string requestedSelection;
    private CheckBox pin;
    private NotifyIcon tray;
    private bool refreshing,preview,online,restoring=true;
    private readonly HashSet<Button> pending=new HashSet<Button>();
    private string viewerUrl;
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern IntPtr FindWindow(string kind,string title);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hwnd,int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
    public static void FocusExisting() {var h=FindWindow(null,WindowTitle);if(h!=IntPtr.Zero){ShowWindowAsync(h,9);SetForegroundWindow(h);}}

    public StudioWindow(Settings value,StudioSettings config) {
      host=value;settings=config;standalone=config.Observer==null?null:new StandaloneObserver(config.Observer);Text=WindowTitle;ClientSize=new Size(380,540);
      FormBorderStyle=FormBorderStyle.FixedSingle;MaximizeBox=false;AutoScaleMode=AutoScaleMode.Dpi;
      BackColor=Color.FromArgb(18,25,36);ForeColor=ink;Font=new Font("Microsoft YaHei UI",9);
      StartPosition=FormStartPosition.CenterScreen;
      var icon=Path.Combine(Path.GetDirectoryName(host.ConfigPath),"CormyLive.ico");
      Icon=File.Exists(icon)?new Icon(icon):SystemIcons.Application;
      LabelAt(this,"可米直播",20,17,244,34,18,ink,FontStyle.Bold);
      pin=new CheckBox {Text="置顶",AutoSize=true,Location=new Point(301,26),ForeColor=muted};
      pin.CheckedChanged+=(s,e)=>{TopMost=pin.Checked;SavePosition();};Controls.Add(pin);
      status=LabelAt(this,"正在连接可米…",21,57,338,25,9,muted,FontStyle.Regular);
      var game=Card(92,222);
      LabelAt(game,standalone==null?"个人游戏观战":"服务器直播观战",15,12,280,26,12,ink,FontStyle.Bold);
      gameState=LabelAt(game,"正在检查观战入口…",15,42,307,23,9,muted,FontStyle.Regular);
      observer=ButtonAt(game,"打开观战客户端",15,76,183,true,async()=>{
        feedback.Text="正在打开观战客户端…";
        var result=standalone==null?await Runtime.OpenObserver(host):await standalone.Open();
        feedback.Text=result.activated?"观战客户端已显示，可在 OBS 中采集。":result.phase=="starting"?"启动请求已提交，正在等待窗口和版本核验。":"窗口未切到前台，可稍后再点击显示。";
      });
      web=ButtonAt(game,"网页画面",208,76,113,false,async()=>{
        var state=await Runtime.Api(host,ConnectionRoute(),false,8);
        Open(StudioSettings.LocalUrl(Convert.ToString(Json.Get(state,"viewer","url"))));
        feedback.Text="网页观战已打开。";
      });
      broadcastMode=ChoiceAt(game,15,119,135);broadcastMode.Items.AddRange(new object[]{"只看可米","指定玩家","自动切换"});broadcastMode.SelectedIndex=2;
      players=ChoiceAt(game,160,119,161);
      broadcastMode.SelectedIndexChanged+=(s,e)=>{if(!updatingSelection){selectionDirty=true;EnableActions();}};
      players.SelectedIndexChanged+=(s,e)=>{if(!updatingSelection)selectionDirty=true;};
      broadcastLabel=LabelAt(game,"等待导播状态…",15,156,306,23,9,muted,FontStyle.Regular);
      applyTarget=ButtonAt(game,"应用观战选择",15,181,306,false,async()=>{
        var index=broadcastMode.SelectedIndex;var player=players.SelectedItem as BroadcastPlayer;
        if(index==0)player=broadcast==null?null:broadcast.Players.Find(p=>p.Name==settings.PrimaryTargetName);
        if(index!=2&&player==null)throw new InvalidOperationException(index==0?"可米当前不在观战列表，请稍后刷新。":"请先选择当前在线的玩家。");
        requestedSelection=await Task.Run(()=>standalone.SelectBroadcast(index==2?"auto":"follow",player==null?null:player.Uuid));
        selectionDirty=false;feedback.Text="选择已提交 · 以当前画面确认实际切换。";
      });
      var figure=Card(326,120);
      LabelAt(figure,"虚拟形象",15,12,280,26,12,ink,FontStyle.Bold);
      avatarState=LabelAt(figure,"正在检查透明窗口…",15,42,307,23,9,muted,FontStyle.Regular);
      avatar=ButtonAt(figure,"显示透明形象",15,76,183,true,()=>{
        settings.OpenAvatar();feedback.Text="已请求显示透明形象，声音沿用现有播放器。";return Task.FromResult(0);
      });
      ButtonAt(figure,"复制 OBS 地址",208,76,113,false,()=>{
        Clipboard.SetText(StudioSettings.LocalUrl(settings.AvatarUrl));feedback.Text="已复制透明形象地址，可用于 OBS 浏览器源。";return Task.FromResult(0);
      });
      ButtonAt(this,"控制台",20,459,105,false,()=>{Open(host.ConsoleUrl);return Task.FromResult(0);});
      ButtonAt(this,"收进托盘",137,459,105,false,()=>{Hide();return Task.FromResult(0);});
      ButtonAt(this,"刷新状态",254,459,105,false,async()=>{await RefreshState();feedback.Text="已刷新状态。";});
      feedback=LabelAt(this,"关闭小助手，游戏和声音继续运行。",21,506,338,28,8,muted,FontStyle.Regular);
      var menu=new ContextMenuStrip();menu.Items.Add("显示直播小助手",null,(s,e)=>Restore());
      menu.Items.Add("退出小助手（直播继续）",null,(s,e)=>Close());
      tray=new NotifyIcon {Icon=Icon,Text=WindowTitle,Visible=true,ContextMenuStrip=menu};tray.DoubleClick+=(s,e)=>Restore();
      timer.Tick+=async(s,e)=>await RefreshState();
      Shown+=async(s,e)=>{if(!preview){LoadPosition();restoring=false;timer.Start();await RefreshState();}};
      Move+=(s,e)=>{if(Visible&&WindowState==FormWindowState.Normal)SavePosition();};
      Resize+=(s,e)=>{if(WindowState==FormWindowState.Minimized)Hide();};
      FormClosed+=(s,e)=>{timer.Stop();timer.Dispose();tray.Visible=false;tray.Dispose();};
    }
    private string ConnectionRoute(){return "/api/webui/providers/"+Uri.EscapeDataString("world:"+host.ObserverWorld)+"/panels/connection/state";}
    private Panel Card(int y,int height){var p=new Panel {Location=new Point(20,y),Size=new Size(340,height),BackColor=Color.FromArgb(28,38,53)};Controls.Add(p);return p;}
    private ComboBox ChoiceAt(Control parent,int x,int y,int width){var c=new ComboBox {Location=new Point(x,y),Size=new Size(width,28),DropDownStyle=ComboBoxStyle.DropDownList,BackColor=Color.FromArgb(39,52,71),ForeColor=ink};parent.Controls.Add(c);return c;}
    private Label LabelAt(Control parent,string text,int x,int y,int width,int height,float size,Color color,FontStyle style){
      var l=new Label {Text=text,Location=new Point(x,y),Size=new Size(width,height),Font=new Font("Microsoft YaHei UI",size,style),ForeColor=color,AutoEllipsis=true};parent.Controls.Add(l);return l;
    }
    private Button ButtonAt(Control parent,string text,int x,int y,int width,bool primary,Func<Task> action){
      var b=new Button {Text=text,Location=new Point(x,y),Size=new Size(width,33),FlatStyle=FlatStyle.Flat,BackColor=primary?accent:Color.FromArgb(39,52,71),ForeColor=primary?Color.FromArgb(14,39,37):ink,Cursor=Cursors.Hand};
      b.FlatAppearance.BorderSize=0;b.Click+=async(s,e)=>{
        if(pending.Contains(b))return;pending.Add(b);b.Enabled=false;EnableActions();
        try{await action();}catch(TaskCanceledException){feedback.Text="服务响应较慢，结果尚未确认。可稍后刷新状态。";}catch(Exception error){feedback.Text=error.GetBaseException().Message;}
        finally{pending.Remove(b);if(!IsDisposed){b.Enabled=true;EnableActions();}}
        if(!IsDisposed)await RefreshState();
      };parent.Controls.Add(b);return b;
    }
    private static void Open(string url){Process.Start(new ProcessStartInfo(StudioSettings.LocalUrl(url)){UseShellExecute=true});}
    private void EnableActions(){if(IsDisposed)return;observer.Enabled=(standalone!=null||online)&&!pending.Contains(observer);web.Enabled=!pending.Contains(web);avatar.Enabled=!pending.Contains(avatar);if(applyTarget!=null){applyTarget.Enabled=standalone!=null&&broadcast!=null&&broadcast.Enabled&&!pending.Contains(applyTarget);broadcastMode.Enabled=applyTarget.Enabled;players.Enabled=applyTarget.Enabled&&broadcastMode.SelectedIndex==1;}}
    private void RefreshBroadcast(BroadcastState state){
      broadcast=state;broadcastLabel.Text=state.Label;
      if(players.DroppedDown||broadcastMode.DroppedDown)return;
      updatingSelection=true;
      try {
        var previous=players.SelectedItem as BroadcastPlayer;string id=previous==null?null:previous.Uuid;
        players.Items.Clear();foreach(var p in state.Players)players.Items.Add(p);
        if(!selectionDirty&&(requestedSelection==null||requestedSelection==state.SelectionId)&&state.Enabled){
          id=state.TargetUuid;
          broadcastMode.SelectedIndex=state.Mode=="auto"?2:state.TargetName==settings.PrimaryTargetName?0:1;
          requestedSelection=null;selectionInitialized=true;
        }
        foreach(BroadcastPlayer p in players.Items)if(p.Uuid==id){players.SelectedItem=p;break;}
        if(!selectionInitialized&&players.SelectedIndex<0&&players.Items.Count>0)players.SelectedIndex=0;
      }finally{updatingSelection=false;}
    }
    private async Task RefreshState(){
      if(refreshing||IsDisposed)return;refreshing=true;
      try{
        var root=await Runtime.Api(host,"/api/status",false,8);if(IsDisposed)return;online=true;
        bool running=Json.IsTrue(Json.Get(root,"loop","running"))&&!Json.IsTrue(Json.Get(root,"loop","paused"));
        status.Text=running?"● 可米在线 · 正在运行":"● 可米在线 · 思考已暂停";status.ForeColor=running?accent:Color.FromArgb(241,195,123);
        var connection=Runtime.Api(host,ConnectionRoute(),false,8);
        var client=standalone==null?Runtime.Api(host,"/api/webui/providers/"+Uri.EscapeDataString("world:"+host.ObserverWorld)+"/panels/mount/client.state",true,8,new{args=new object[0]}):null;
        try{var c=await connection;viewerUrl=Json.Get(c,"viewer","url")==null?null:StudioSettings.LocalUrl(Convert.ToString(Json.Get(c,"viewer","url")));}catch{viewerUrl=null;}
        if(client!=null)try{var c=await client;if(IsDisposed)return;var phase=Convert.ToString(Json.Get(c,"phase"));gameState.Text=phase=="running"?(Json.IsTrue(Json.Get(c,"windowReady"))?"个人观战运行中 · 点击切回窗口":"个人观战进程已启动 · 窗口准备中"):phase=="starting"?"个人观战正在启动…":phase=="error"||phase=="failed"?"个人观战异常 · 可打开控制台":"个人观战未打开 · 可按需启动";}catch{if(!IsDisposed)gameState.Text="客户端状态未确认 · 可打开控制台";}
      }catch{online=false;viewerUrl=null;status.Text="● 暂时连不上可米 · 打开控制台检查";status.ForeColor=muted;gameState.Text="观战入口暂不可用";}
      if(standalone!=null){var current=await Task.Run(()=>standalone.Probe());var view=await Task.Run(()=>standalone.Broadcast());if(!IsDisposed){gameState.Text=current.Label;RefreshBroadcast(view);}}
      else broadcastLabel.Text="此入口未配置独立导播";
      refreshing=false;if(!IsDisposed){avatarState.Text=settings.AvatarLabel();EnableActions();}
    }
    private void Restore(){Show();WindowState=FormWindowState.Normal;Activate();}
    private void SavePosition(){if(restoring||preview||!Visible||WindowState!=FormWindowState.Normal)return;try{Json.Write(settings.StateFile,new{x=Left,y=Top,pinned=TopMost});}catch{}}
    private void LoadPosition(){try{var p=Json.Read<object>(settings.StateFile);var point=new Point(Convert.ToInt32(Json.Get(p,"x")),Convert.ToInt32(Json.Get(p,"y")));var rect=new Rectangle(point,Size);foreach(var screen in Screen.AllScreens)if(Rectangle.Intersect(screen.WorkingArea,rect).Width>100&&Rectangle.Intersect(screen.WorkingArea,rect).Height>100){Location=point;break;}pin.Checked=Json.IsTrue(Json.Get(p,"pinned"));}catch{}}
    public void Preview(string path){preview=true;tray.Visible=false;ShowInTaskbar=false;Opacity=0;Show();Application.DoEvents();status.Text="● 可米在线 · 正在运行";status.ForeColor=accent;gameState.Text=standalone==null?"个人观战未打开 · 可按需启动":settings.Observer.ExpectedAccount+" · "+settings.Observer.ExpectedLoader.Split('-')[0]+" · "+settings.Observer.NativeVersion+" · 跟拍中";avatarState.Text="透明窗口已显示 · 独立字幕";using(var bmp=new Bitmap(Width,Height)){DrawToBitmap(bmp,new Rectangle(0,0,Width,Height));bmp.Save(path);}Close();}
  }
}
