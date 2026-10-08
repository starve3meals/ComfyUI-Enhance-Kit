import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

export const fixture = () => ({ schema_version: 1, revision: 2,
  categories: [{id:'cat',name:'写实'},{id:'video',name:'视频'}],
  prompts: [{id:'portrait',category_id:'cat',title:'人物',text:'原正文'},
            {id:'camera',category_id:'video',title:'镜头',text:''}] });

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes,no) => { resolve=yes; reject=no; });
  return {promise,resolve,reject};
}

class Element extends EventTarget {
  constructor(tag) { super(); this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.style={};this.value='';this.textContent='';this.hidden=false;this.className='';this.classList={add:(name)=>{this.className+=' '+name;}}; }
  get value(){ return this._value; }
  set value(value){ this._value=this.tagName==='TEXTAREA'?String(value).replace(/\r\n?/g,'\n'):value; }
  append(...children) { for(const child of children){child.remove();this.children.push(child);child.parent=this;} }
  before(child) { const parent=this.parent;if(!parent)return;child.remove();parent.children.splice(parent.children.indexOf(this),0,child);child.parent=parent; }
  replaceChildren(...children) { this.children=[];this.append(...children); }
  remove() { if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);this.parent=undefined; }
  setAttribute(key,value) { this[key]=value; }
  focus() { this.focused=true; }
  querySelector(selector) { return this.querySelectorAll(selector)[0]??null; }
  querySelectorAll(selector) { const nodes=this.children.flatMap(c=>[c,...c.querySelectorAll('*')]);if(selector==='*')return nodes;const action=selector.match(/^\[data-action="(.*)"\]$/)?.[1];return nodes.filter(c=>action?c.dataset.action===action:c.tagName.toLowerCase()===selector); }
}

export async function loadLibrary({entry='prompt_library.js', fetchApi, autoLifecycle=true}={}) {
  const world = {library:fixture(), requests:[], extensions:[], alerts:[]};
  const window = new EventTarget();
  const document = {head:new Element('head'),body:new Element('body'),createElement:tag=>new Element(tag)};
  const app = {rootGraph:{}, graph:null, registerExtension:e=>world.extensions.push(e)};
  const dialogs=new Map(),mounts=[],unmounts=[];
  world.host={
    flushMounts(){for(const mount of mounts.splice(0))mount();},
    flushUnmounts(){for(const unmount of unmounts.splice(0))unmount();},
    remove(dialog=world.dialog){
      if(!dialogs.delete(dialog.key))return;
      dialog.closed=true;
      dialog.spec.dialogComponentProps.onRemoved?.();
      unmounts.push(()=>{
        if(dialog.mounted){dialog.spec.component.beforeUnmount?.call(dialog.instance);dialog.spec.component.unmounted?.call(dialog.instance);}
        dialog.element.remove();
      });
      if(autoLifecycle)queueMicrotask(()=>world.host.flushUnmounts());
    },
    dismiss(kind){
      const dialog=world.dialog,props=dialog.spec.dialogComponentProps;
      if(kind==='escape'?props.closable!==false:kind==='mask'?props.dismissableMask!==false:props.dismissOnFocusOutside!==false)world.host.remove(dialog);
    }
  };
  app.extensionManager={dialog:{showExtensionDialog(spec){
    const key=spec.key.startsWith('extension-')?spec.key:`extension-${spec.key}`;
    const dialog={key,spec,element:new Element('div')};
    dialogs.set(key,dialog);world.dialog=dialog;
    mounts.push(()=>{
      if(dialog.closed)return;
      const anchor=new Element('#comment');dialog.element.append(anchor);document.body.append(dialog.element);
      dialog.instance={$el:anchor};dialog.mounted=true;spec.component.mounted.call(dialog.instance);
    });
    if(autoLifecycle)queueMicrotask(()=>world.host.flushMounts());
    return {dialog,closeDialog:()=>{const current=dialogs.get(spec.key);if(current)world.host.remove(current);}};
  }}};
  app.graph=app.rootGraph;
  const api = {user:'a', fetchApi:fetchApi ?? (async (path,options={}) => {
    world.requests.push({path,options});
    if (path.endsWith('/resolve')) {
      const id=JSON.parse(options.body).prompt_id;
      const prompt=world.library.prompts.find(p=>p.id===id);
      if (!prompt) return response({error:{code:'not_found',message:'已删除，请重新选择'}},404);
      const category=world.library.categories.find(c=>c.id===prompt.category_id);
      return response({...prompt,revision:world.library.revision,category_name:category.name});
    }
    return response(world.library);
  })};
  const context=vm.createContext({console,URL,AbortController,window,document,setTimeout,clearTimeout});
  const cache=new Map();
  const globals=new Map([
    ['app.js',new vm.SyntheticModule(['app'],function(){this.setExport('app',app);},{context})],
    ['api.js',new vm.SyntheticModule(['api'],function(){this.setExport('api',api);},{context})],
  ]);
  async function load(name) {
    if(cache.has(name))return cache.get(name);
    const source=await readFile(new URL('../../web/'+name,import.meta.url),'utf8');
    const module=new vm.SourceTextModule(source,{context,identifier:name,initializeImportMeta:meta=>{meta.url='http://localhost/extensions/kit/'+name;}});
    cache.set(name,module);
    await module.link(specifier=> {
      if(specifier.includes('/scripts/'))return globals.get(specifier.split('/').at(-1));
      return load(specifier.replace('./',''));
    });
    return module;
  }
  const module=await load(entry);
  await module.evaluate();
  world.app=app; world.api=api; world.window=window; world.document=document; world.module=module;
  world.extension=world.extensions[0];
  world.node=async()=>{
    const node={comfyClass:'EnhanceKitPromptLibrary',properties:{},graph:app.rootGraph,size:[320,260],
      widgets:[{name:'resolved_text',type:'customtext',value:'',options:{},element:{readOnly:false,placeholder:''}}],
      addWidget(type,name,value,callback,options={}){const w={type,name,value,callback,options};this.widgets.push(w);return w;},
      setSize(size){this.size=size;},setDirtyCanvas(){}};
    await world.extension.nodeCreated(node);
    return node;
  };
  return world;
}

export const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>structuredClone(body)});
export const widget=(node,name)=>node.widgets.find(w=>w.name===name);
export async function choose(node,category='cat',prompt='portrait') {
  const categoryWidget=widget(node,'分类'),promptWidget=widget(node,'提示词');
  categoryWidget.value=category; await categoryWidget.callback(category);
  promptWidget.value=prompt; await promptWidget.callback(prompt);
}
