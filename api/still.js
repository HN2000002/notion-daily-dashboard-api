const { Client } = require('@notionhq/client');
const { createHash, timingSafeEqual } = require('node:crypto');

// This route extends the existing widget connection. Its Notion token stays in Vercel.
// Only the owner-private Still server receives the separate STILL_SYNC_KEY.
const SOURCES = Object.freeze({
  goalTasks: { database: '2e4cd388-8383-81f3-9ed6-cb3b8f5e190c', collection: '2e4cd388-8383-8193-b29a-000bac6c611b', title: 'Task name', date: 'Target date', label: 'Goal steps' },
  everydayTasks: { database: '213cd388-8383-80d9-b893-ebbb1c52faf9', collection: '213cd388-8383-81fd-a530-000b42e8dce6', title: 'Name', date: 'Due Date', label: 'Everyday' },
  goals: { database: '2e4cd388-8383-817f-9fa7-d0efcc7a69f5', collection: '2e4cd388-8383-81ca-8013-000b2a6eaee2', title: 'Goal Name', label: 'Goals' }
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normalizeId = value => String(value || '').replace(/-/g, '').toLowerCase();
const titleText = property => (property?.title || []).map(t => t.plain_text || t.text?.content || '').join('');
function todayLondon() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date()); }
function authorized(req) {
  const secret = process.env.STILL_SYNC_KEY;
  const bearer = req.headers.authorization;
  if (!secret || secret.length < 40 || typeof bearer !== 'string' || !bearer.startsWith('Bearer ') || bearer.length > 256) return false;
  return timingSafeEqual(createHash('sha256').update(bearer.slice(7)).digest(), createHash('sha256').update(secret).digest());
}
function send(res, status, body) { return res.status(status).json(body); }
function taskFromPage(page, key) {
  const source = SOURCES[key], p = page.properties;
  return { id:page.id, title:titleText(p[source.title]) || 'Untitled task', url:page.url,
    status:p.Status?.status?.name || 'Not started', dueDate:p[source.date]?.date?.start || (key === 'everydayTasks' ? p.Date?.date?.start : null) || null,
    goalIds:(p['Related goal']?.relation || []).map(r => r.id), source:key, sourceLabel:source.label,
    priority:p.Priority?.select?.name || null, lastEdited:page.last_edited_time };
}
async function queryPages(notion, source, filter) {
  const results = []; let cursor;
  do {
    const response = await notion.databases.query({database_id:source.database, page_size:100, ...(cursor?{start_cursor:cursor}:{}), ...(filter?{filter}:{})});
    results.push(...response.results); cursor=response.has_more?response.next_cursor:null;
  } while (cursor && results.length < 400);
  return {results, hasMore:Boolean(cursor)};
}
async function readSource(notion, key) {
  const source=SOURCES[key],today=todayLondon();
  const filter=key==='goals'?undefined:{or:[{property:'Status',status:{does_not_equal:'Done'}},{timestamp:'last_edited_time',last_edited_time:{on_or_after:today}}]};
  const response=await queryPages(notion,source,filter);
  if(key!=='goals')return {items:response.results.map(p=>taskFromPage(p,key)),hasMore:response.hasMore,today};
  return {items:response.results.map(page=>{
    const p=page.properties, rollup=p['Goal Progress']?.rollup;
    const value=rollup?.type==='number'?rollup.number:null;
    return {id:page.id,title:titleText(p['Goal Name'])||'Untitled goal',url:page.url,progress:typeof value==='number'&&Number.isFinite(value)?Math.max(0,Math.min(1,value)):null,priority:p.Priority?.select?.name==='PRIORITY'};
  }),hasMore:response.hasMore,today};
}
async function setTask(notion, taskId, status) {
  const page=await notion.pages.retrieve({page_id:taskId});
  if(page.archived||page.in_trash){const e=new Error('Task is archived. Refresh your list.');e.status=409;throw e;}
  const parent=normalizeId(page.parent?.database_id || page.parent?.data_source_id);
  const key=['goalTasks','everydayTasks'].find(key=>[SOURCES[key].database,SOURCES[key].collection].some(id=>normalizeId(id)===parent));
  if(!key){const e=new Error('This task is outside your connected task lists.');e.status=403;throw e;}
  const current=page.properties.Status?.status?.name;
  if(!current){const e=new Error('This task has no supported Status property.');e.status=409;throw e;}
  // Setting a desired status is idempotent. An uncertain request is never automatically replayed.
  const updated=current===status?page:await notion.pages.update({page_id:taskId,properties:{Status:{status:{name:status}}}});
  return {task:taskFromPage(updated,key)};
}
module.exports=async function handler(req,res) {
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='POST'){res.setHeader('Allow','POST');return send(res,405,{status:'error',code:'method_not_allowed',message:'Use POST.'});}
  if(!process.env.STILL_SYNC_KEY)return send(res,503,{status:'error',code:'connection_not_ready',message:'The existing widget connection needs its Still sync key.'});
  if(!authorized(req))return send(res,401,{status:'error',code:'unauthorized',message:'Connection authorization failed.'});
  if(!process.env.NOTION_TOKEN)return send(res,503,{status:'error',code:'connection_not_ready',message:'The existing Notion connection is not configured.'});
  let body;
  try{body=typeof req.body==='string'?JSON.parse(req.body):req.body;if(!body||JSON.stringify(body).length>4096)throw Error();}catch{return send(res,400,{status:'error',code:'invalid_request',message:'Invalid request.'});}
  const read=body.action==='read'&&Object.hasOwn(SOURCES,body.source);
  const write=body.action==='setTask'&&UUID.test(body.taskId)&&['Done','Not started','In progress'].includes(body.status);
  if(!read&&!write)return send(res,400,{status:'error',code:'invalid_request',message:'Unsupported task or goal action.'});
  const notion=new Client({auth:process.env.NOTION_TOKEN,maxRetries:0});
  try{
    const data=read?await readSource(notion,body.source):await setTask(notion,body.taskId,body.status);
    return send(res,200,{status:'success',data,updatedAt:new Date().toISOString()});
  }catch(error){
    const rateLimited=error.status===429||error.code==='rate_limited';
    if(rateLimited)res.setHeader('Retry-After','10');
    const status=rateLimited?429:error.status===403||error.status===404?error.status:error.status===409?409:502;
    const message=rateLimited?'Notion is busy. Please wait a moment before refreshing.':status===404||status===403?'The widget connection needs access to this Notion database. Open it in Notion and add the same connection used by your existing widgets.':status===409?error.message:write?'The update could not be confirmed. Refresh before trying again.':'Notion could not be refreshed. Please try again.';
    return send(res,status,{status:'error',code:rateLimited?'rate_limited':status===403||status===404?'notion_access_required':'provider_error',message});
  }
};
