import {spawn} from "node:child_process"
/** Secret decrypt+HTTP stay in the native child. Only a fixed numeric summary can cross back.
 * No raw response, headers, URLs, exception text or model-controlled code is returned. */
export const HTTP_SCRIPT=`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$data=$null;$clear=$null;$client=$null;$response=$null
try {
 Add-Type -AssemblyName System.Security
 Add-Type -AssemblyName System.Net.Http
 $meta=[Console]::In.ReadToEnd()|ConvertFrom-Json
 $uri=[Uri]$meta.url
 if($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment){throw 'denied'}
 $bytes=[Convert]::FromBase64String($meta.blob)
 $data=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 $clear=[Text.Encoding]::UTF8.GetString($data)|ConvertFrom-Json
 if([string]::IsNullOrEmpty($clear.password)){throw 'missing'}
 $handler=New-Object System.Net.Http.HttpClientHandler
 $handler.AllowAutoRedirect=$false; $handler.UseCookies=$false
 $client=New-Object System.Net.Http.HttpClient -ArgumentList $handler
 $client.Timeout=[TimeSpan]::FromSeconds(20)
 $client.DefaultRequestHeaders.Authorization=New-Object System.Net.Http.Headers.AuthenticationHeaderValue -ArgumentList 'Bearer',([string]$clear.password)
 $clock=[Diagnostics.Stopwatch]::StartNew()
 $response=$client.GetAsync($uri,[Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
 $clock.Stop()
 # No response body is read: even a server echo/encoding of a secret never reaches the model or logs.
 @{status=[int]$response.StatusCode;durationMs=[Math]::Min(60000,[int]$clock.ElapsedMilliseconds)}|ConvertTo-Json -Compress
} catch {[Console]::Error.Write('Vault HTTP failed');exit 1}
finally {if($data){[Array]::Clear($data,0,$data.Length)};if($clear){$clear.password=$null;$clear.login=$null};if($response){$response.Dispose()};if($client){$client.Dispose()}}
`
export function allowedUrl(site:string,input:string):URL {
 const base=new URL(site),url=new URL(input)
 if(base.protocol!=="https:"||url.protocol!=="https:"||base.username||base.password||base.search||base.hash||url.username||url.password||url.search||url.hash||url.origin!==base.origin)throw Error("Vault request must match the operator-saved HTTPS site; no credentials, queries or redirects.")
 const prefix=base.pathname.replace(/\/$/,"")
 if(url.pathname!==prefix+"/models")throw Error("Vault check is limited to the saved base URL plus /models; arbitrary requests are not supported.")
 return url
}
export function httpSummary(value:unknown):{status:number;durationMs:number}{
 const v=value as Record<string,unknown>|null
 if(!v||Object.keys(v).some(key=>!["status","durationMs"].includes(key))||!Number.isInteger(v.status)||Number(v.status)<100||Number(v.status)>599||!Number.isInteger(v.durationMs)||Number(v.durationMs)<0||Number(v.durationMs)>60000)throw Error("Vault HTTP invalid result; output withheld.")
 return {status:Number(v.status),durationMs:Number(v.durationMs)}
}
export function nativeHttp(platform=process.platform,launch:typeof spawn=spawn){return async(blob:string,url:string)=>{
 if(platform!=="win32")throw Error("Vault HTTP requires Windows DPAPI. No plaintext fallback.")
 return new Promise<{status:number;durationMs:number}>((resolve,reject)=>{
  const root=process.env.SystemRoot||"C:\\Windows"
  const child=launch(`${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,["-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(HTTP_SCRIPT,"utf16le").toString("base64")],{stdio:["pipe","pipe","pipe"],windowsHide:true})
  let output="",settled=false
  const finish=(value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);output="";try{child.kill()}catch{};try{if(value===undefined)throw Error();resolve(httpSummary(value))}catch{reject(Error("Vault HTTP failed; output withheld."))}}
  const timer=setTimeout(()=>finish(),25000)
  child.on("error",()=>finish());child.stdout!.setEncoding("utf8");child.stdout!.on("data",(chunk:string)=>{output+=chunk;if(output.length>512)finish()});child.stderr!.resume()
  child.on("close",code=>{try{finish(code===0?JSON.parse(output):undefined)}catch{finish()}})
  child.stdin!.on("error",()=>finish());child.stdin!.end(JSON.stringify({blob,url}))
 })
}}
