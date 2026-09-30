'use strict';
const { Codex } = require('./codex');
const { pngDimensions } = require('./core');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
function createWorker({store,complete,cwd,clientFactory=()=>new Codex()}) {
  const {state,save} = store;
  let client, connecting, active, stopped = false;
  const connection = {mode:'codex-local',automaticGeneration:true,status:'disconnected',label:'Codex · existing subscription',detail:'Connecting to Codex…'};
  async function connect() {
    if(connecting)return connecting;
    if(connection.status === 'ready')return;
    connecting = (async()=>{
      client?.removeAllListeners('disconnected'); client?.close(); client=clientFactory(); connection.status='connecting';connection.detail='Connecting to your signed-in Codex…';
      client.on('disconnected',e=>{if(stopped || connection.status==='error')return;connection.status='disconnected';connection.detail=e.message;});
      try { await client.connect(); connection.status='ready';connection.detail='GPT-6 Astra is ready. Generate, draft, and refine here using your Codex subscription.'; }
      catch(e){connection.status='error';connection.detail=e.message;client.close();throw e;}
      finally {connecting=null;}
    })();
    return connecting;
  }
  function refs(job) {
    const list = [...job.references];
    if(job.dependsOn) { const prior=state.jobs.find(j=>j.id===job.dependsOn);const ix=list.findIndex(r=>r.role.startsWith('Left reference'));if(ix!==-1)list.splice(ix,1);list.push({role:'Left reference: match the finished left wall’s style.',url:prior.result}); }
    return list;
  }
  async function drain() {
    if(active || stopped || connection.status!=='ready')return;
    for(const j of state.jobs.filter(j=>j.status==='queued' && j.dependsOn)) {
      if(['failed','cancelled','interrupted','blocked'].includes(state.jobs.find(p=>p.id===j.dependsOn)?.status)) {j.status='blocked';j.error='The left image did not finish. Generate the sides again when ready.';save();}
    }
    const job=state.jobs.slice().reverse().find(j=>j.status==='queued' && (!j.dependsOn || state.jobs.find(p=>p.id===j.dependsOn)?.status==='completed'));
    if(!job)return;
    const controller=new AbortController();active={id:job.id,controller};job.status='running';job.progress='Preparing your request…';save();
    try {
      const references=refs(job);
      const prompt=[job.kind==='draft'?'Write a concise standalone image prompt only. Do not generate an image.':'Use your built-in image generation tool to '+(job.kind==='refine'?'edit the attached image':'generate exactly one image')+'.',
        `Scene: ${job.scene}`,`User direction: ${job.prompt}`,job.fixedRules,`Requested output: ${job.settings.size}, landscape 16:9. Quality direction: ${job.settings.quality}.`,...references.map((r,i)=>`Image ${i+1}: ${r.role}`)].join('\n\n');
      const result=await client.run({cwd,prompt,draft:job.kind==='draft',references:references.map(r=>store.mediaPath(r.url)),signal:controller.signal,onProgress:message=>{if(job.status==='running'){job.progress=message;save();}}});
      if(job.status!=='running')return;
      if(result.bytes) {
        const dim=pngDimensions(result.bytes);
        if(dim.width*9!==dim.height*16) {
          const name=randomUUID()+'.png';fs.writeFileSync(path.join(store.dataDir,'media',name),result.bytes);
          Object.assign(job,{status:'needs-fit',original:'/media/'+name,originalWidth:dim.width,originalHeight:dim.height,source:result.source,progress:'Image ready. Choose “Fit & use” to trim and resize it to your selected 16:9 size.'});save();return;
        }
      }
      complete({id:job.id,prompt:result.prompt,data:result.bytes?.toString('base64'),source:result.source});
    } catch(e) { if(job.status==='running'){job.status='failed';job.error=e.message;save();} }
    finally {active=null;if(!stopped)setImmediate(()=>drain());}
  }
  function cancel(id) {if(active?.id===id)active.controller.abort();}
  function close(){stopped=true;active?.controller.abort();client?.close();}
  return {connection,connect,drain,cancel,close};
}
module.exports={createWorker};
