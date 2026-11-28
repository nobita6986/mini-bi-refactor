import {jobSitemap} from "@/lib/portal/sitemap";
export const dynamic="force-dynamic";
export function GET(){return jobSitemap();}
