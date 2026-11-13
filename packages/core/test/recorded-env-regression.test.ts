import {test,expect} from "bun:test"
import {RoomRules} from "@orchestra/schema/room-rules"
test("site test assertions and JS template interpolation are not host environment dumps",()=>{
 for(const command of ["$code = @'\nassert.ok(nameInput.classList.contains('has-error'), 'Empty name must set has-error');\n'@\nSet-Content tests/site.test.js $code", "Write-Output 'CSS contains ${primaryTokenHex} and ${accentTokenHex}'"])
  expect(RoomRules.commandLeaksCredentials(command)).toBe(false)
 for(const command of ["set", "cmd /c set", "echo hi; set", "node -e 'console.log(process.env)'", "printenv", "echo $GITHUB_TOKEN", "echo ${API_KEY}"])
  expect(RoomRules.commandLeaksCredentials(command)).toBe(true)
})
