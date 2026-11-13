import {test,expect} from "bun:test"
import {SessionDeliveryState as D} from "../src/session/delivery-state.js"
import type {SessionMessage} from "../src/session/message.js"
const history = [{type:"user",id:"u1"},{type:"assistant",id:"a1",finish:"stop",content:[{type:"text",text:"Delivered result"}]}] as unknown as SessionMessage.Info[]
test("delivery receipt survives serialization but not a new user or worker result",()=>{
 const receipt=JSON.parse(JSON.stringify(D.receipt(history)))
 expect(D.matches(receipt,history)).toBe(true)
 expect(D.matches(receipt,[...history,{type:"user",id:"u2"} as SessionMessage.Info])).toBe(false)
 expect(D.matches(receipt,[...history,{type:"synthetic",id:"s1"} as SessionMessage.Info])).toBe(false)
 expect(D.matches({},history)).toBe(false)
})
test("failed, incomplete, empty or tool-only responses cannot seal delivery",()=>{
 for(const patch of [{error:{message:"failure"}},{finish:"tool-calls"},{content:[]},{content:[{type:"text",text:" "}]}]){
  expect(D.receipt([history[0]!,{...history[1]!,...patch} as SessionMessage.Info])).toBeUndefined()
 }
})
