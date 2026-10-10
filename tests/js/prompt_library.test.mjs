import test from 'node:test';
import assert from 'node:assert/strict';
import {loadLibrary,choose,widget,deferred,response} from './prompt_library_helpers.mjs';

test('category filters titles and explicit category switch clears selection',async()=>{
  const world=await loadLibrary(); await world.extension.setup();
  const node=await world.node(); await choose(node);
  assert.equal(widget(node,'resolved_text').value,'原正文');
  assert.deepEqual(Array.from(widget(node,'提示词').options.values),['','portrait']);
  await widget(node,'分类').callback('video');
  assert.equal(node.properties.enhanceKitPromptLibrary.prompt_id,'');
  assert.equal(widget(node,'resolved_text').value,'');
  assert.deepEqual(Array.from(widget(node,'提示词').options.values),['','camera']);
});

test('serializer reads latest body and holds a fixed execution snapshot',async()=>{
  const world=await loadLibrary(); await world.extension.setup();
  const node=await world.node(); await choose(node);
  const text=widget(node,'resolved_text');
  world.library.prompts[0].text='  中文\r\n{a|b}  ';
  const snapshot=await text.serializeValue({widgets:node.widgets},0);
  world.library.prompts[0].text='又改了';
  assert.equal(snapshot,'  中文\r\n{a|b}  ');
  assert.equal(text.options.read_only,true);
  assert.equal(text.element.readOnly,true);
  assert.equal(text.dynamicPrompts,false);
  assert.equal(text.serialize,false);
  assert.equal(widget(node,'分类').options.serialize,false);
});

test('rename and move keep prompt reference and use current label',async()=>{
  const world=await loadLibrary(); await world.extension.setup();
  const node=await world.node(); await choose(node);
  world.library.prompts[0].category_id='video'; world.library.prompts[0].title='新人像';
  world.module.namespace.refreshPromptLibraryNodes(world.library);
  assert.equal(node.properties.enhanceKitPromptLibrary.category_id,'video');
  assert.equal(node.properties.enhanceKitPromptLibrary.prompt_id,'portrait');
  assert.equal(widget(node,'提示词').options.getOptionLabel('portrait'),'新人像');
});

test('empty body is valid but deleted reference never falls back to preview',async()=>{
  const world=await loadLibrary(); await world.extension.setup();
  const node=await world.node(); await choose(node,'video','camera');
  assert.equal(await widget(node,'resolved_text').serializeValue(), '');
  world.library.prompts=[];
  await assert.rejects(widget(node,'resolved_text').serializeValue());
});

test('selection or user change during resolve rejects the pending submission',async()=>{
  for(const change of ['selection','user','graph','removed']){
    const world=await loadLibrary(); await world.extension.setup();
    const node=await world.node(); await choose(node);
    const gate=deferred(); world.api.fetchApi=()=>gate.promise;
    const pending=widget(node,'resolved_text').serializeValue();
    if(change==='selection') await widget(node,'分类').callback('video');
    if(change==='user')world.api.user='b';
    if(change==='graph')world.app.rootGraph={};
    if(change==='removed'){node.onRemoved(); node.graph=null;}
    gate.resolve(response({id:'portrait',category_id:'cat',category_name:'写实',title:'人物',text:'late',revision:3}));
    await assert.rejects(pending);
  }
});

test('restored and copied nodes resolve their own stable references',async()=>{
  const world=await loadLibrary(); await world.extension.setup();
  const first=await world.node();await choose(first);
  const second=await world.node();
  second.properties=structuredClone(first.properties);second.onConfigure({});
  await choose(second,'video','camera');
  assert.equal(await widget(first,'resolved_text').serializeValue(),'原正文');
  assert.equal(await widget(second,'resolved_text').serializeValue(),'');
  first.onRemoved();first.graph=null;
  assert.equal(await widget(second,'resolved_text').serializeValue(),'');
});

test('out-of-order preview cannot overwrite another selection',async()=>{
  const world=await loadLibrary(); await world.extension.setup();
  const node=await world.node(); await choose(node);
  const gate=deferred();world.api.fetchApi=()=>gate.promise;
  const pending=widget(node,'提示词').callback('portrait');
  await widget(node,'分类').callback('video');
  gate.resolve(response({id:'portrait',category_id:'cat',text:'旧请求',revision:2}));
  await pending;
  assert.equal(widget(node,'resolved_text').value,'');
  assert.equal(node.properties.enhanceKitPromptLibrary.category_id,'video');
});

test('subgraph node and restored empty library retain only stable references',async()=>{
  const world=await loadLibrary(); await world.extension.setup();
  const node=await world.node();node.graph={};await choose(node);
  assert.equal(await widget(node,'resolved_text').serializeValue(),'原正文');
  world.library.categories=[];world.library.prompts=[];
  await world.extension.afterConfigureGraph();
  assert.equal(node.properties.enhanceKitPromptLibrary.prompt_id,'portrait');
  assert.equal(widget(node,'resolved_text').value,'');
  assert.equal(widget(node,'提示词').options.getOptionLabel('portrait'),'提示词已删除，请重新选择');
  await assert.rejects(widget(node,'resolved_text').serializeValue());
});

test('older refresh response or failure cannot undo a saved library',async()=>{
  for(const failure of [false,true]){
    const world=await loadLibrary();await world.extension.setup();const node=await world.node();await choose(node);
    const old=structuredClone(world.library),gate=deferred();world.api.fetchApi=()=>gate.promise;
    world.window.dispatchEvent(new Event('focus'));
    world.library.prompts[0].text='已保存的新正文';world.library.revision++;
    world.module.namespace.refreshPromptLibraryNodes(world.library);
    if(failure)gate.reject(new Error('旧读取失败'));else gate.resolve(response(old));
    await new Promise(r=>setImmediate(r));
    assert.equal(widget(node,'resolved_text').value,'已保存的新正文');
  }
});

test('same node restored to the graph follows saved library changes and submits latest text',async()=>{
  const world=await loadLibrary();await world.extension.setup();
  const restored=await world.node(),other=await world.node();
  await choose(restored);await choose(other);
  restored.onRemoved();restored.graph=null;
  restored.graph=world.app.rootGraph;restored.onAdded?.(world.app.rootGraph);
  restored.onConfigure({});
  const updated=structuredClone(world.library);updated.revision++;updated.prompts[0].text='恢复后保存的新正文';
  world.library=updated;world.module.namespace.refreshPromptLibraryNodes(updated);
  assert.equal(widget(restored,'resolved_text').value,'恢复后保存的新正文');
  assert.equal(widget(other,'resolved_text').value,'恢复后保存的新正文');
  assert.equal(await widget(restored,'resolved_text').serializeValue(),'恢复后保存的新正文');
});

test('reattaching invalidates old resolves and renders the library saved while detached',async()=>{
  const world=await loadLibrary();await world.extension.setup();
  const node=await world.node();await choose(node);
  const gate=deferred(),fetchApi=world.api.fetchApi;world.api.fetchApi=()=>gate.promise;
  const pending=widget(node,'提示词').callback('portrait');
  node.onRemoved();node.graph=null;
  const updated=structuredClone(world.library);updated.revision++;updated.prompts[0].text='离开画布期间的新正文';
  world.library=updated;world.module.namespace.refreshPromptLibraryNodes(updated);
  assert.equal(widget(node,'resolved_text').value,'');
  node.graph=world.app.rootGraph;node.onAdded?.(world.app.rootGraph);
  assert.equal(widget(node,'resolved_text').value,'离开画布期间的新正文');
  gate.resolve(response({id:'portrait',category_id:'cat',text:'过期正文',revision:2}));
  await pending;
  assert.equal(widget(node,'resolved_text').value,'离开画布期间的新正文');
  world.api.fetchApi=fetchApi;
  assert.equal(await widget(node,'resolved_text').serializeValue(),'离开画布期间的新正文');
});

test('reattaching after a user switch waits for that users library before allowing submission',async()=>{
  const world=await loadLibrary();await world.extension.setup();
  const node=await world.node();await choose(node);
  node.onRemoved();node.graph=null;world.api.user='b';
  const gate=deferred(),fetchApi=world.api.fetchApi;world.api.fetchApi=()=>gate.promise;
  node.graph=world.app.rootGraph;node.onAdded?.(world.app.rootGraph);
  assert.equal(widget(node,'resolved_text').value,'');
  await assert.rejects(widget(node,'resolved_text').serializeValue(),/当前用户/);
  world.library={schema_version:1,revision:1,categories:[{id:'cat-b',name:'用户B分类'}],
    prompts:[{id:'prompt-b',category_id:'cat-b',title:'用户B标题',text:'用户B正文'}]};
  gate.resolve(response(world.library));await new Promise(r=>setImmediate(r));
  assert.deepEqual(Array.from(widget(node,'分类').options.values),['','cat-b']);
  assert.equal(widget(node,'resolved_text').value,'');
  world.api.fetchApi=fetchApi;await choose(node,'cat-b','prompt-b');
  assert.equal(await widget(node,'resolved_text').serializeValue(),'用户B正文');
});
