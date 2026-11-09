/** Accept an old pasted confirmation prefix, but never ask for or depend on it. */
export function parseScheduleLimit(value:string,day=false):number|null|undefined {
 const text=value.trim().replace(/^РАЗРЕШИТЬ\s+/i,"").trim().toLowerCase()
 if(!day&&text==="без лимита")return null
 if(!/^\d+$/.test(text))return
 const number=Number(text)
 return Number.isInteger(number)&&number>=1&&number<=(day?100:10000)?number:undefined
}
