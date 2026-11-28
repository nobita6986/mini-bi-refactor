"use client";
import {useEffect,useMemo,useRef,useState} from "react";
import {useTheme} from "@/lib/theme/theme-provider";
import {BiSpatial3DEngine,type Anchor} from "@/lib/portal/spatial/spatial-3d-engine";
import {buildBiSpatialHierarchy} from "@/lib/portal/spatial/spatial-adapter";
import type {SpatialProps} from "./spatial-explorer";

export function SpatialScene({jobs,tileConfig,onFailure}:SpatialProps){
  const {themeId}=useTheme(),canvas=useRef<HTMLCanvasElement>(null),engine=useRef<BiSpatial3DEngine|null>(null),layer=useRef<HTMLDivElement>(null);
  const data=useMemo(()=>buildBiSpatialHierarchy(jobs),[jobs]);
  const [park,setPark]=useState(""),[company,setCompany]=useState(""),[night,setNight]=useState(false),[satellite,setSatellite]=useState(false);
  const current=useRef({onFailure,themeId});useEffect(()=>{current.current={onFailure,themeId}},[onFailure,themeId]);
  const currentPark=data.industrial_parks.find(p=>p.industrial_park_code===park);
  const currentCompany=data.companies.find(c=>c.company_key===company);
  useEffect(()=>{
    if(!canvas.current)return;
    const el=canvas.current;
    const activeParks=new Set(data.industrial_parks.filter(p=>p.job_count>0).map(p=>p.industrial_park_code));
    const chooseCompany=(key:string)=>{setCompany(key);setPark(data.companies.find(c=>c.company_key===key)?.industrial_park_code??"");};
    const anchors=new Map(Array.from(layer.current?.querySelectorAll<HTMLButtonElement>("[data-anchor]")??[]).map(b=>[b.dataset.anchor,b]));
    function update(positions:Anchor[]){
      const drawn=new Set<string>();const boxes:{x:number;y:number}[]=[];
      for(const a of positions.sort((a,b)=>a.distance-b.distance)){
        const b=anchors.get(a.key);if(!b||!a.visible||a.x<74||a.x>el.clientWidth-74||a.y<91||a.y>el.clientHeight-95)continue;
        if(boxes.some(p=>Math.abs(p.x-a.x)<145&&Math.abs(p.y-a.y)<31))continue;
        b.style.left=a.x+"px";b.style.top=a.y+"px";b.hidden=false;drawn.add(a.key);boxes.push(a);
      }
      for(const [key,b] of anchors)if(!drawn.has(key!))b.hidden=true;
    }
    let e:BiSpatial3DEngine|undefined;
    let observer:ResizeObserver|undefined;
    const fail=()=>current.current.onFailure();
    const pause=(event:Event)=>{if(e)e.renderPaused=(event as ContentVisibilityAutoStateChangeEvent).skipped;};
    const highlight=(ev:Event)=>{const link=(ev.target as HTMLElement).closest<HTMLAnchorElement>(".job-results a[data-job]");const c=data.companies.find(item=>item.jobs.some(j=>j.public_slug===link?.dataset.job));
      if(e)e.highlightNode(ev.type==="pointerover"&&c?{type:"company",key:c.company_key}:null);};
    const frame=el.closest(".jobs-explorer");
    try {
      e=new BiSpatial3DEngine({canvas:el,skinId:current.current.themeId,tileOrigin:tileConfig?.origin??null,
        onSelectKcn:key=>{if(activeParks.has(key)){setPark(key);setCompany("");}},onSelectCompany:chooseCompany,onScreenAnchorsUpdate:update,
        onHoverNode:node=>{const key=node?.companyKey??node?.key;const c=data.companies.find(item=>item.company_key===key);for(const a of frame?.querySelectorAll<HTMLElement>("[data-job]")??[])a.toggleAttribute("data-highlight",Boolean(c?.jobs.some(j=>j.public_slug===a.dataset.job)));}});
      engine.current=e;e.setHierarchyData(data,{preserveView:false});observer=new ResizeObserver(()=>e?.resize());observer.observe(el);
      el.addEventListener("webglcontextlost",fail);el.addEventListener("contentvisibilityautostatechange",pause);
      frame?.addEventListener("pointerover",highlight);frame?.addEventListener("pointerout",highlight);
    } catch {fail();}
    return()=>{engine.current=null;observer?.disconnect();e?.dispose();el.removeEventListener("webglcontextlost",fail);el.removeEventListener("contentvisibilityautostatechange",pause);frame?.removeEventListener("pointerover",highlight);frame?.removeEventListener("pointerout",highlight);};
  },[data,tileConfig]);
  useEffect(()=>{engine.current?.setSkinTheme(themeId)},[themeId]);
  const choosePark=(key:string)=>{setPark(key);setCompany("");if(key)engine.current?.flyToLevel2(key);else engine.current?.flyToLevel1();};
  const chooseCompany=(key:string)=>{const c=data.companies.find(c=>c.company_key===key);if(c){setPark(c.industrial_park_code);setCompany(key);engine.current?.flyToLevel3(key);}};
  return <section className="jobs-scene" aria-label="Bản đồ khu công nghiệp"><canvas ref={canvas} aria-hidden="true"/>
    <div className="map-top"><button onClick={()=>choosePark("")}>Toàn miền Bắc</button>{currentPark&&<button onClick={()=>choosePark(park)}>{currentPark.industrial_park_name}</button>}{currentCompany&&<span>{currentCompany.customer_name}</span>}</div>
    <div ref={layer} className="map-anchors">{data.industrial_parks.filter(p=>p.job_count>0).map(p=><button hidden key={p.industrial_park_code} data-anchor={p.industrial_park_code} onClick={()=>choosePark(p.industrial_park_code)}>{p.industrial_park_name}</button>)}{data.companies.map(c=><button hidden key={c.company_key} data-anchor={c.company_key} onClick={()=>chooseCompany(c.company_key)}>{c.customer_name}</button>)}</div>
    <div className="map-bottom"><label>Khu công nghiệp <select value={park} onChange={ev=>choosePark(ev.target.value)}><option value="">Toàn miền Bắc</option>{data.industrial_parks.filter(p=>p.job_count>0).map(p=><option key={p.industrial_park_code} value={p.industrial_park_code}>{p.industrial_park_name}</option>)}</select></label>
    {currentPark&&<select aria-label="Nhà máy" value={company} onChange={ev=>ev.target.value?chooseCompany(ev.target.value):choosePark(park)}><option value="">Tất cả nhà máy</option>{currentPark.companies.map(c=><option key={c.company_key} value={c.company_key}>{c.customer_name}</option>)}</select>}
    {currentCompany&&<>{Object.entries({south:"Nam",east:"Đông",north:"Bắc",west:"Tây"}).map(([s,label])=><button key={s} onClick={()=>engine.current?.orbitCompanySide(s)}>{label}</button>)}{currentCompany.jobs.map((j,i)=><a key={j.public_slug} href={"/viec-lam/"+j.public_slug}>Xem tin{currentCompany.jobs.length>1?" "+(i+1):""}</a>)}</>}
    <button onClick={()=>{engine.current?.setDayNightMode(!night);setNight(!night)}}>{night?"Ban ngày":"Ban đêm"}</button>
    {tileConfig&&<button onClick={()=>{engine.current?.setMapStyle(satellite?"street":"satellite");setSatellite(!satellite)}}>{satellite?"Bản đồ đường":"Vệ tinh"}</button>}
    <small>Sơ đồ định hướng · {tileConfig?.credit??"Vị trí minh họa"}</small></div></section>;
}
