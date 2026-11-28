"use client";
import Link from "next/link";
import Image from "next/image";
import {THEMES} from "@/lib/theme/theme-registry";
import {useTheme} from "@/lib/theme/theme-provider";
export function PortalHeader(){
  const {theme,setTheme}=useTheme();
  return <header className="jobs-header"><Link prefetch={false} className="jobs-brand" href="/"><Image unoptimized src="/brand/hrpartner-logo.png" alt="" width="52" height="36"/>Việc làm miền Bắc</Link>
    <nav aria-label="Điều hướng"><a href="/viec-lam">Việc làm</a><a href="/gioi-thieu">Giới thiệu</a><a href="/lien-he">Liên hệ</a></nav>
    <details className="jobs-skins"><summary aria-label="Chọn màu giao diện"><i style={{background:theme.light.primary}}/></summary>
    <div>{THEMES.map(t=><button key={t.id} aria-pressed={theme.id===t.id} onClick={e=>{setTheme(t.id);e.currentTarget.closest("details")?.removeAttribute("open");}}>{[t.light.primary,t.light.secondary,t.light.accent].map((c,i)=><i key={i} style={{background:c}}/>)}{t.name} {theme.id===t.id?"✓":""}</button>)}</div></details>
  </header>;
}
