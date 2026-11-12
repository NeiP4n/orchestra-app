// Creates a private blank local configuration. Never inserts or prints credentials.
import { mkdir, writeFile, lstat } from 'node:fs/promises'
import path from 'node:path'
const directory = path.join(process.cwd(), '.orchestra')
await mkdir(directory, { recursive: true, mode: 0o700 })
if ((await lstat(directory)).isSymbolicLink()) throw Error("Local OAuth directory must not be a link.")
const file = path.join(directory, 'credentials.env')
try {
  await writeFile(file, '# Enter your own OAuth application values locally. Never commit this file.\nORCHESTRA_ANTIGRAVITY_CLIENT_ID=\nORCHESTRA_ANTIGRAVITY_CLIENT_SECRET=\n', { flag: 'wx', mode: 0o600 })
  console.log('Created ' + file + '. Edit locally, then restart Orchestra.')
} catch (error) {
  if (error.code !== 'EEXIST') throw error
  console.log('Already exists: ' + file + '. Left unchanged.')
}
