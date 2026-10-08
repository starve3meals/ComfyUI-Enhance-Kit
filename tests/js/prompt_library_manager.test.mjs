import test from 'node:test';
import assert from 'node:assert/strict';
import {loadLibrary,response,deferred} from './prompt_library_helpers.mjs';

const control=(world,name)=>world.dialog.element.querySelector(`[data-action="${name}"]`);
async function open(world){const done=world.module.namespace.openPromptLibraryManager({categoryId:'cat',promptId:'portrait',onSaved:()=>{}});await new Promise(resolve=>setImmediate(resolve));return done;}
async function input(world,name,value){const element=control(world,name);element.value=value;element.oninput?.();}

test('opening locates reference, renders text and cancel retains dirty draft',async()=>{
  const world=await loadLibrary({entry:'prompt_library_manager.js'});const done=open(world);await new Promise(r=>setImmediate(r));
  assert.equal(control(world,'title').value,'人物');
  await input(world,'text','<img src=x onerror=alert(1)>');
  const closing=world.dialog.close();await new Promise(r=>setImmediate(r));
  await control(world,'cancel-dirty').onclick();await closing;
  assert.equal(world.dialog.closed,undefined);
  assert.equal(control(world,'text').value,'<img src=x onerror=alert(1)>');
  assert.equal(world.dialog.element.querySelector('img'),null);
  const again=world.dialog.close();await new Promise(r=>setImmediate(r));await control(world,'discard-dirty').onclick();await again;await done;
  assert.equal(world.dialog.element.removed,true);
});

test('save sends exact body and conflict retains draft without retry',async()=>{
  const world=await loadLibrary({entry:'prompt_library_manager.js'});const done=open(world);await new Promise(r=>setImmediate(r));
  let calls=0,body;
  world.api.fetchApi=async(path,options)=>{calls++;body=JSON.parse(options.body);return response({error:{code:'revision_conflict',message:'库已更新'}},409);};
  await input(world,'text','  中文\n{a|b}  ');await control(world,'save').onclick();
  assert.equal(calls,1);assert.equal(body.expected_revision,2);assert.equal(body.action,'prompt.update');
  assert.equal(body.data.text,'  中文\n{a|b}  ');assert.equal(control(world,'text').value,body.data.text);
  const closing=world.dialog.close();await new Promise(r=>setImmediate(r));await control(world,'discard-dirty').onclick();await closing;await done;
});

test('close during save waits for result, successful save closes cleanly',async()=>{
  const world=await loadLibrary({entry:'prompt_library_manager.js'});const done=open(world);await new Promise(r=>setImmediate(r));
  const gate=deferred();world.api.fetchApi=()=>gate.promise;
  await input(world,'text','新正文');const saving=control(world,'save').onclick();
  const closing=world.dialog.close();await new Promise(r=>setImmediate(r));assert.equal(world.dialog.closed,undefined);
  world.library.prompts[0].text='新正文';gate.resolve(response({...world.library,revision:3}));
  await saving;await closing;await done;assert.equal(world.dialog.closed,true);
});

test('nonempty category cannot be deleted and prompt delete requires confirmation',async()=>{
  const world=await loadLibrary({entry:'prompt_library_manager.js'});const done=open(world);await new Promise(r=>setImmediate(r));
  assert.equal(control(world,'delete-category').disabled,true);
  const deleting=control(world,'delete-prompt').onclick();await new Promise(r=>setImmediate(r));
  assert.equal(world.requests.length,1);
  await control(world,'cancel-delete').onclick();await deleting;
  assert.equal(world.requests.length,1);
  await world.dialog.close();await done;
});

test('category and prompt CRUD, move and empty body use all six actions',async()=>{
  const world=await loadLibrary({entry:'prompt_library_manager.js'});const done=open(world);await new Promise(r=>setImmediate(r));
  const calls=[];
  const updated=structuredClone(world.library);
  world.api.fetchApi=async(path,options)=>{
    const body=JSON.parse(options.body);calls.push(body);updated.revision++;
    if(calls.length===1)updated.categories.push({id:'aux',name:'风格'});
    if(calls.length===2)updated.categories[2].name='画风';
    if(calls.length===3)updated.prompts.push({id:'new',category_id:'aux',title:'手绘',text:'原文'});
    if(calls.length===4)updated.prompts[2]={id:'new',category_id:'video',title:'手绘',text:''};
    if(calls.length===5)updated.prompts.pop();
    if(calls.length===6)updated.categories.pop();
    return response(updated);
  };
  await input(world,'category-name','风格');await control(world,'create-category').onclick();
  await input(world,'category-name','画风');await control(world,'rename-category').onclick();
  await control(world,'create-prompt').onclick();await input(world,'title','手绘');await input(world,'text','原文');await control(world,'save').onclick();
  control(world,'target').value='video';await input(world,'text','');await control(world,'save').onclick();
  const deleting=control(world,'delete-prompt').onclick();await new Promise(r=>setImmediate(r));await control(world,'confirm-delete').onclick();await deleting;
  control(world,'category').value='aux';await control(world,'category').onchange();await control(world,'delete-category').onclick();
  assert.deepEqual(calls.map(c=>c.action),['category.create','category.rename','prompt.create','prompt.update','prompt.delete','category.delete']);
  assert.deepEqual(calls.map(c=>c.expected_revision),[2,3,4,5,6,7]);
  assert.equal(calls[3].data.category_id,'video');assert.equal(calls[3].data.text,'');
  await world.dialog.close();await done;
});

test('late refresh cannot roll back the revision after a save',async()=>{
  const world=await loadLibrary({entry:'prompt_library_manager.js'});const done=open(world);await new Promise(r=>setImmediate(r));
  const gate=deferred(), calls=[];
  world.api.fetchApi=async(path,options)=>{
    if(!options.body)return gate.promise;
    calls.push(JSON.parse(options.body));return response({...world.library,revision:3});
  };
  const refreshing=control(world,'refresh').onclick();
  await input(world,'text','新正文');await control(world,'save').onclick();
  gate.resolve(response(world.library));await refreshing;
  await input(world,'text','再改');await control(world,'save').onclick();
  assert.equal(calls[1].expected_revision,3);
  await world.dialog.close();await done;
});

test('duplicate opening reuses window and user switch removes it',async()=>{
  const world=await loadLibrary({entry:'prompt_library_manager.js'});
  const first=world.module.namespace.openPromptLibraryManager();
  const second=world.module.namespace.openPromptLibraryManager();assert.equal(first,second);
  await new Promise(r=>setImmediate(r));
  world.api.user='b';world.window.dispatchEvent(new Event('focus'));await first;
  assert.equal(world.dialog.element.removed,true);assert.equal(world.document.body.children.length,0);
});

test('typing while refresh is pending preserves the newest draft',async()=>{
  const world=await loadLibrary({entry:'prompt_library_manager.js'});const done=open(world);await new Promise(r=>setImmediate(r));
  const gate=deferred();world.api.fetchApi=()=>gate.promise;
  await input(world,'text','刷新前');const refreshing=control(world,'refresh').onclick();
  await input(world,'text','刷新等待中继续编辑');await input(world,'title','新标题');control(world,'target').value='video';
  gate.resolve(response(world.library));await refreshing;
  assert.equal(control(world,'text').value,'刷新等待中继续编辑');assert.equal(control(world,'title').value,'新标题');assert.equal(control(world,'target').value,'video');
  const closing=world.dialog.close();await new Promise(r=>setImmediate(r));await control(world,'discard-dirty').onclick();await closing;await done;
});

test('title-only edit preserves original CRLF despite textarea normalization',async()=>{
  const world=await loadLibrary({entry:'prompt_library_manager.js'});const raw='  中文\r\n{a|b}  ';world.library.prompts[0].text=raw;
  const done=open(world);await new Promise(r=>setImmediate(r));
  assert.equal(control(world,'text').value,'  中文\n{a|b}  ');
  let saved;world.api.fetchApi=async(path,options)=>{saved=JSON.parse(options.body);world.library.prompts[0].title=saved.data.title;return response(world.library);};
  await input(world,'title','改标题');await control(world,'save').onclick();
  assert.equal(saved.data.text,raw);
  await world.dialog.close();await done;
});
