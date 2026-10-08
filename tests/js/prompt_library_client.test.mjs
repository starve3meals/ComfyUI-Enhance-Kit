import test from 'node:test';
import assert from 'node:assert/strict';
import {loadLibrary,response} from './prompt_library_helpers.mjs';

test('client uses fixed same-origin paths and exact JSON',async()=>{
  const calls=[];
  const world=await loadLibrary({entry:'prompt_library_client.js',fetchApi:async(path,options)=>{calls.push({path,options});return response({revision:3,text:''});}});
  const client=world.module.namespace;
  await client.readLibrary();
  await client.mutateLibrary(2,'prompt.delete',{id:'p'});
  await client.resolvePrompt('p');
  assert.equal(calls[0].path,'/enhance-kit/prompt-library');
  assert.equal(calls[0].options.cache,'no-store');
  assert.deepEqual(JSON.parse(calls[1].options.body),{expected_revision:2,action:'prompt.delete',data:{id:'p'}});
  assert.equal(calls[2].path,'/enhance-kit/prompt-library/resolve');
  assert.deepEqual(JSON.parse(calls[2].options.body),{prompt_id:'p'});
});

test('HTTP failure is rejected with actionable status and no stale fallback',async()=>{
  const world=await loadLibrary({entry:'prompt_library_client.js',fetchApi:async()=>response({error:{code:'revision_conflict',message:'刷新后重试'}},409)});
  await assert.rejects(world.module.namespace.readLibrary(),error=>error.status===409&&error.code==='revision_conflict');
});

test('non-JSON server failure still reports HTTP status',async()=>{
  const world=await loadLibrary({entry:'prompt_library_client.js',fetchApi:async()=>({ok:false,status:503,json:async()=>{throw new SyntaxError('html');}})});
  await assert.rejects(world.module.namespace.readLibrary(),error=>error.status===503);
});
