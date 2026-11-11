import { SafetyConfig as S } from "../../src/safety-config"
import { Limits } from "../../src/limits"
import { runtimeLimits } from "../../src/autoloop/runtime-limits"
const mode=process.argv[2]
if(mode==="write")S.write({version:1,disabled:true,drainMs:60000,drainTokens:1000,browserMax:2,localTest:false})
if(mode==="restore")S.restore()
const off=mode!=="restore"
if(Limits.fullyDisabled()!==off||(!off&&Limits.drainWallClockMs()!==60000)||off&&runtimeLimits()?.maxHops!==Infinity)throw Error("safety persistence or restore failed")
console.log("PASS safety",mode,"off=",off,"browserMax=",S.read().browserMax)
