import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import path from "node:path"

type Artifact = {
  channel: string
  name: string
  distribution: string
  version: string
  metadata: Record<string, unknown>
}

export namespace UpdateArtifact {
  export async function publish(artifact: Artifact) {
    if (process.env.GITHUB_ACTIONS !== "true") {
      console.log("skipped update artifact publication outside GitHub Actions")
      return
    }
    const requestURL = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
    const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    if (!requestURL || !requestToken) throw new Error("GitHub Actions OIDC is unavailable")

    // No Orchestra update domain exists yet: the publish endpoint comes from
    // ORCHESTRA_UPDATE_PUBLISH_URL (set it to https://<update-domain>/api/publish
    // once the Worker is deployed). The OIDC audience is the publish URL's
    // origin, so it always agrees with the Worker.
    const publishURL = process.env.ORCHESTRA_UPDATE_PUBLISH_URL
    if (!publishURL) {
      throw new Error(
        "ORCHESTRA_UPDATE_PUBLISH_URL is not set: the update Worker has no domain yet, so there is nowhere to publish to",
      )
    }
    const url = new URL(requestURL)
    url.searchParams.set("audience", new URL(publishURL).origin)
    const tokenResponse = await fetch(url, { headers: { Authorization: `Bearer ${requestToken}` } })
    if (!tokenResponse.ok) throw new Error(`Failed to request GitHub OIDC token: ${tokenResponse.status}`)
    const token: unknown = await tokenResponse.json()
    if (!isRecord(token) || typeof token.value !== "string")
      throw new Error("GitHub OIDC response did not include a token")

    for (const attempt of [0, 1, 2]) {
      const response = await fetch(publishURL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.value}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(artifact),
      })
      if (response.ok) return
      // D1 can commit the upsert and still time out. Replaying the same artifact is safe.
      if (response.status >= 500 && attempt < 2) {
        await response.arrayBuffer()
        console.warn(`Update artifact publication returned ${response.status}; retrying`)
        await Bun.sleep((attempt + 1) * 1_000)
        continue
      }
      throw new Error(`Failed to publish update artifact: ${response.status} ${await response.text()}`)
    }
  }

  export async function upload(input: { version: string; files: string[]; dryRun?: boolean }) {
    const { PutObjectCommand, S3Client } = await import("@aws-sdk/client-s3")
    const client = input.dryRun ? undefined : new S3Client(await credentials())
    // No Orchestra files bucket exists yet: both come from the environment so
    // artifacts can never be uploaded to the upstream bucket by accident.
    const bucket = process.env.ORCHESTRA_UPDATE_FILES_BUCKET
    if (!bucket) throw new Error("ORCHESTRA_UPDATE_FILES_BUCKET is not set")
    const filesBase = process.env.ORCHESTRA_UPDATE_FILES_BASE_URL
    if (!filesBase) throw new Error("ORCHESTRA_UPDATE_FILES_BASE_URL is not set")
    const prefix = `bin/${input.version}/`
    const base = `${filesBase.replace(/\/$/, "")}/bin/${encodeURIComponent(input.version)}/`
    try {
      return Object.fromEntries(
        await Promise.all(
          input.files.map(async (filepath) => {
            const file = Bun.file(filepath)
            const name = path.basename(filepath)
            if (!file.size) throw new Error(`Empty release file: ${filepath}`)
            const hash = createHash("sha256")
            for await (const chunk of file.stream()) hash.update(chunk)
            const metadata = { url: `${base}${encodeURIComponent(name)}`, sha256: hash.digest("hex"), size: file.size }
            console.log(`${input.dryRun ? "dry-run upload" : "upload"}: ${prefix}${name}`)
            if (client) {
              await client.send(
                new PutObjectCommand({
                  Bucket: bucket,
                  Key: `${prefix}${name}`,
                  Body: createReadStream(filepath),
                  ContentLength: file.size,
                  ContentType: name.endsWith(".tar.gz") ? "application/gzip" : file.type || "application/octet-stream",
                  ContentDisposition: `attachment; filename="${name}"`,
                  CacheControl: "public, max-age=31536000, immutable",
                }),
              )
            }
            return [name, metadata] as const
          }),
        ),
      )
    } finally {
      client?.destroy()
    }
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

async function credentials() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!account || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required")
  // R2 uses the token ID as its access key and SHA-256(token) as its secret.
  for (const scope of [`accounts/${account}`, "user"]) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/${scope}/tokens/verify`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) continue
    const data: unknown = await response.json()
    if (!isRecord(data) || data.success !== true || !isRecord(data.result) || typeof data.result.id !== "string")
      continue
    return {
      region: "auto",
      endpoint: `https://${account}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: data.result.id,
        secretAccessKey: createHash("sha256").update(token).digest("hex"),
      },
    }
  }
  throw new Error("Cloudflare token verification failed")
}
