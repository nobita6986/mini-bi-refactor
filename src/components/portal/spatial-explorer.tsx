"use client";
import {useEffect,useState,type ReactNode,type ComponentType} from "react";
import type {PublicJob} from "@/lib/portal/jobs-contract";

export type SpatialProps = {jobs:PublicJob[]; tileConfig:{origin:string;credit:string}|null; onFailure:()=>void};
export function SpatialExplorer({jobs,tileConfig,children}:Omit<SpatialProps,"onFailure">&{children:ReactNode}){
  const [Scene,setScene]=useState<ComponentType<SpatialProps>|null>(null);
  const [wide,setWide]=useState(false),[enabled,setEnabled]=useState(true),[unavailable,setUnavailable]=useState(false);
  useEffect(()=>{const mq=matchMedia("(min-width: 900px)"); const update=()=>setWide(mq.matches);update();mq.addEventListener("change",update);return()=>mq.removeEventListener("change",update);},[]);
  useEffect(()=>{
    if(!wide||!enabled||!jobs.length||unavailable)return;
    let active=true;
    import("./spatial-scene").then(mod=>{if(active)setScene(()=>mod.SpatialScene);}).catch(()=>{if(active)setUnavailable(true);});
    return()=>{active=false};
  },[wide,enabled,jobs.length,unavailable]);
  const visible=wide && enabled && !unavailable && Scene && jobs.length>0;
  return <>{wide&&jobs.length>0&&!unavailable&&<button className="jobs-mode" aria-pressed={enabled} onClick={()=>setEnabled(!enabled)}>{enabled?"Danh sách 2D":"Mở bản đồ 3D"}</button>}
  {wide&&unavailable&&<p role="status">Bản đồ 3D chưa khả dụng trên thiết bị này. Bạn có thể xem toàn bộ tin trong danh sách.</p>}
  <div className={visible?"jobs-explorer spatial":"jobs-explorer"}>{children}{visible&&<Scene jobs={jobs} tileConfig={tileConfig} onFailure={()=>setUnavailable(true)}/>}</div></>;
}
