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
  append(...children) { this.children.push(...children);for(const child of children)child.parent=this; }
  replaceChildren(...children) { this.children=[];this.append(...children); }
  remove() { if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);this.removed=true; }
  setAttribute(key,value) { this[key]=value; }
  focus() { this.focused=true; }
  querySelector(selector) { return this.querySelectorAll(selector)[0]??null; }
  querySelectorAll(selector) { const nodes=this.children.flatMap(c=>[c,...c.querySelectorAll('*')]);if(selector==='*')return nodes;const action=selector.match(/^\[data-action="(.*)"\]$/)?.[1];return nodes.filter(c=>action?c.dataset.action===action:c.tagName.toLowerCase()===selector); }
}

export async function loadLibrary({entry='prompt_library.js', fetchApi}={}) {
  const world = {library:fixture(), requests:[], extensions:[], alerts:[]};
  const window = new EventTarget();
  const document = {head:new Element('head'),body:new Element('body'),createElement:tag=>new Element(tag)};
  window.comfyAPI={ui:{ComfyDialog:class {
    constructor(){this.element=new Element('div');world.dialog=this;document.body.append(this.element);}
    show(content){this.element.append(content);}
    close(){this.closed=true;}
  }}};
  const app = {rootGraph:{}, graph:null, registerExtension:e=>world.extensions.push(e)};
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
