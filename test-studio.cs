using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading.Tasks;
using CormyLive;

static class StudioTests {
  static void Check(bool ok,string name){if(!ok)throw new Exception(name);Console.WriteLine("PASS "+name);}
  static async Task Observer(string initial,bool shouldStart,bool lostResponse=false) {
    { var socket=new System.Net.Sockets.TcpListener(IPAddress.Loopback,0);
      socket.Start();var port=((IPEndPoint)socket.LocalEndpoint).Port;socket.Stop();
      using(var server=new HttpListener()) {
        server.Prefixes.Add("http://127.0.0.1:"+port+"/");server.Start();
        int starts=0,reads=0;bool legacy=false;
        var loop=Task.Run(async()=>{while(server.IsListening){HttpListenerContext c;try{c=await server.GetContextAsync();}catch{return;}var route=c.Request.Url.AbsolutePath;
          legacy|=route.Contains("/api/console/");string phase;
          if(route.EndsWith("client.start")){starts++;phase="error";if(lostResponse)c.Response.StatusCode=503;}else{reads++;phase=reads==1?initial:"error";}
          var bytes=Encoding.UTF8.GetBytes("{\"phase\":\""+phase+"\",\"pid\":null,\"detail\":\"fixture terminal\"}");
          c.Response.ContentType="application/json";c.Response.OutputStream.Write(bytes,0,bytes.Length);c.Response.Close();
        }});
        bool failed=false;try{await Runtime.OpenObserver(new Settings{ConsoleUrl="http://127.0.0.1:"+port});}catch(InvalidOperationException){failed=true;}
        server.Stop();await loop;
        Check(failed,"terminal/unknown remains an error: "+initial);
        Check(starts==(shouldStart?1:0),"start count: "+initial);
        Check(!legacy,"current webui route: "+initial);
        if(lostResponse)Check(reads==2,"uncertain start queries once instead of replay");
      }
    }
  }
  static int Main(){try{
    Check(StudioSettings.LocalUrl("http://127.0.0.1:7793")=="http://127.0.0.1:7793/","local viewer URL");
    foreach(var url in new[]{"https://example.org/","file:///C:/test","http://user:pass@localhost/","javascript:alert(1)"}){bool rejected=false;try{StudioSettings.LocalUrl(url);}catch(InvalidDataException){rejected=true;}Check(rejected,"reject non-local/credential URL");}
    foreach(var state in new[]{"stopped","starting","running","unrecognized"})Observer(state,state=="stopped").GetAwaiter().GetResult();
    Observer("stopped",true,true).GetAwaiter().GetResult();
    Console.WriteLine("21 checks passed; fixture only, zero game/model/audio calls.");return 0;
  }catch(Exception e){Console.Error.WriteLine(e);return 1;}}
}
