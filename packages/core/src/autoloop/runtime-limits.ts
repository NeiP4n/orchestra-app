import { Limits } from "../limits.js"
import type { AutoloopLimits } from "./kernel/decide.js"
/** Operator acknowledgement is sampled on every service decision; it never changes rule/content validation. */
export function runtimeLimits(configured?:Partial<AutoloopLimits>):Partial<AutoloopLimits>|undefined{
 return Limits.fullyDisabled()?{...configured,maxAttempts:Infinity,maxVerifyIterations:Infinity,failureRepeatStop:Infinity,maxHops:Infinity}:configured
}
