import type {Metadata} from "next";
import {PUBLIC_JOB_ORIGIN} from "@/lib/portal/host";
import {PortalHeader} from "@/components/portal/portal-header";
import "./portal.css";

export const dynamic="force-dynamic";
export const metadata:Metadata={metadataBase:new URL(PUBLIC_JOB_ORIGIN),title:"Việc làm miền Bắc",description:"Tìm việc làm tại các khu công nghiệp miền Bắc."};
export default function PortalLayout({children}:{children:React.ReactNode}){
  return <div className="jobs-portal"><PortalHeader/>{children}</div>;
}
