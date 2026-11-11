import { expect, test } from "@playwright/test"
import { mockWorkspace } from "../utils/workspace"

for(const width of [1440,768,390]) test(`connected shell template file export and reviewed import at ${width}`,async({page},info)=>{
 await page.context().grantPermissions(["clipboard-read","clipboard-write"])
 await page.setViewportSize({width,height:900})
 await mockWorkspace(page,{name:"Template transfer",seed:{tabs:[],settings:{appearance:{animations:false}}}})
 await page.route("**/api/orchestra/project",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify([{id:"prj_source",name:"Test2"}])}))
 await page.route("**/api/orchestra/project-template",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify([{id:"process:demo",name:"Test2"}])}))
 await page.route("**/api/orchestra/project-template/export-file",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({path:"C:/Projects/Test2/Test2.orchestra-template",warning:"Do not commit to git"})}))
 await page.route("**/api/orchestra/project-template/prepare-import",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({token:"pti_review",name:"Friend",details:"Portable process only",unresolvedRoles:[]})}))

 let confirmed=0
 await page.route("**/api/orchestra/project-template/confirm-import",route=>{
  confirmed++

  return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:"process:friend",name:"Friend"})})})
 await page.goto("/")
 await page.getByText("Шаблоны: экспорт / импорт файла",{exact:true}).click()
 const pane=page.locator('[data-slot="template-files"]')
 await pane.getByRole("button",{name:"Экспорт в файл",exact:true}).click()
 await expect(pane.getByRole("status")).toContainText("C:/Projects/Test2/Test2.orchestra-template")
 await expect(pane.getByRole("status")).toContainText("Не добавляйте в git")
 await expect(pane.getByRole("button",{name:"Открыть папку",exact:true})).toBeDisabled()
 await pane.getByRole("button",{name:"Скопировать путь",exact:true}).click()
 await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe("C:/Projects/Test2/Test2.orchestra-template")
 await expect(pane.getByText("Отправьте этот файл другу. У него: Импорт из файла.",{exact:true})).toBeVisible()
 await page.screenshot({path:info.outputPath(`template-file-${width}.png`),fullPage:true})
 await pane.getByLabel("Путь к файлу шаблона",{exact:true}).fill("C:/Downloads/Friend.orchestra-template")
 await pane.getByRole("button",{name:"Импорт из файла",exact:true}).click()
 await expect(pane.getByText("Добавить «Friend» в библиотеку? Это не создаёт проект и ничего не запускает.")).toBeVisible()
 expect(confirmed).toBe(0)
 await pane.getByRole("button",{name:"Подтвердить импорт",exact:true}).click()
 await expect(pane.getByRole("status")).toHaveText("Шаблон добавлен в библиотеку. Ничего не запущено.")
 expect(confirmed).toBe(1)
})
