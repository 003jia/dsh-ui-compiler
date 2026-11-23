// This tool changes the worker's public checklist. It has no editor access.
const statuses = ['queued', 'running', 'done']
export const taskPlanSpec = {
  name: 'uic_update_plan',
  description: 'Show or update your short checklist for this design. Supply the complete list of concrete user-visible deliverables in the language of the request. Track at most one step in progress. This tool does not change the canvas.',
  inputSchema: {type:'object',additionalProperties:false,required:['tasks'],properties:{tasks:{
    type:'array',minItems:1,maxItems:6,items:{type:'object',additionalProperties:false,required:['title','status'],
      properties:{title:{type:'string',minLength:1,maxLength:100},status:{type:'string',enum:statuses}}},
  }}},
}

export function updateTaskPlan(slot, args) {
  const tasks = args?.tasks
  const invalid = () => Object.assign(new Error('Use up to six uniquely named task steps and at most one running step'), {code:'invalid_request',reason:'invalid_plan'})
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 6 || Object.keys(args).length !== 1) throw invalid()
  const clean = tasks.map(step => {
    if (!step || typeof step.title !== 'string' || !step.title.trim() || step.title.length > 100 ||
        /[\u0000-\u001f\u007f]/u.test(step.title) || !statuses.includes(step.status) || Object.keys(step).length !== 2) throw invalid()
    return {title:step.title.trim(),status:step.status}
  })
  if (clean.filter(step => step.status === 'running').length > 1 || new Set(clean.map(step => step.title)).size !== clean.length) throw invalid()
  slot.tasks = clean
  return {tasks:clean}
}
