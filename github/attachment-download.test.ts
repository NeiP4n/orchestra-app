import { expect, test } from "bun:test"
import { attachmentURL, downloadAttachment } from "./attachment-download"

test("validates parsed GitHub attachment origin and path, not a substring", () => {
  expect(attachmentURL("https://github.com/user-attachments/assets/example").hostname).toBe("github.com")
  for (const value of ["http://github.com/user-attachments/a", "https://github.com.attacker.invalid/user-attachments/a", "https://github.com@127.0.0.1/user-attachments/a", "https://github.com:8443/user-attachments/a", "https://github.com/user-attachments/../../other", "https://127.0.0.1/user-attachments/a"]) expect(() => attachmentURL(value)).toThrow()
})

test("rejects private-host redirects before a second request", async () => {
  const urls: string[] = []
  const request = (async (url: string) => {
    urls.push(url)
    return new Response(null, {status:302,headers:{location:"http://127.0.0.1/private"}})
  }) as typeof fetch
  await expect(downloadAttachment("https://github.com/user-attachments/assets/example", "synthetic-fixture", request)).rejects.toThrow()
  expect(urls).toHaveLength(1)
})

test("follows approved CDN redirects without forwarding the GitHub credential", async () => {
  const requests: Array<{url:string;options:RequestInit|undefined}> = []
  const request = (async (url: string, options?: RequestInit) => {
    requests.push({url,options})
    return requests.length === 1 ? new Response(null,{status:302,headers:{location:"https://objects.githubusercontent.com/example"}}) : new Response("image")
  }) as typeof fetch
  expect((await downloadAttachment("https://github.com/user-attachments/assets/example", "synthetic-fixture", request)).status).toBe(200)
  expect(requests[0]!.options?.redirect).toBe("manual")
  expect(requests[0]!.options?.headers).toHaveProperty("Authorization")
  expect(requests[1]!.options?.headers).not.toHaveProperty("Authorization")
})

test("bounds redirect loops", async () => {
  let calls=0
  const request=(async()=>{calls++;return new Response(null,{status:302,headers:{location:"/user-attachments/loop"}})}) as typeof fetch
  await expect(downloadAttachment("https://github.com/user-attachments/assets/example", "synthetic-fixture", request)).rejects.toThrow()
  expect(calls).toBe(4)
})
