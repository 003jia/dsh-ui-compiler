import assert from 'node:assert/strict'
import test from 'node:test'

const {updateTaskPlan} = await import(new URL('../dsh-entry/task-plan.mjs',import.meta.url).href)

test('public task updates are per worker, validated before replacing the active checklist',()=>{
  const worker = {tasks:[]}, other = {tasks:[]}
  const tasks = [{title:'绘制计时按钮',status:'running'}, {title:'核对文字布局',status:'queued'}]
  const result = updateTaskPlan(worker,{tasks})
  assert.deepEqual(result.tasks,tasks)
  assert.deepEqual(other.tasks,[])
  assert.throws(()=>updateTaskPlan(worker,{tasks:tasks.map(task=>({...task,status:'running'}))}),{reason:'invalid_plan'})
  assert.deepEqual(worker.tasks,tasks)
})
