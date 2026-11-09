import {test,expect} from "bun:test"
import {scopePaths,disjointScopes} from "../src/staffing"
test("auto staffing requires known, project-relative disjoint paths; unknown and overlaps wait",()=>{
 expect(scopePaths(["src/api", "src/api"])).toEqual(["src/api"])
 expect(disjointScopes(["src/ui"],[["src/api"],["tests/api"]])).toBe(true)
 for(const scope of [["src"],["src/api"],["src/api/index.ts"],[],undefined])expect(disjointScopes(scope,[["src/api"]])).toBe(false)
 for(const scope of [undefined,[],["../outside"],["C:\\private"],["/private"],["src/*"],["src/./a"]])expect(scopePaths(scope)).toBeUndefined()
 expect(disjointScopes(["src/ui"],[undefined])).toBe(false)
 expect(disjointScopes(["src/ui"],[])).toBe(false)
})
