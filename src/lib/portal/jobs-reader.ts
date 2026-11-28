import "server-only";
import {createServiceSupabaseClient} from "../supabase/server.ts";
import {type JobsQuery,jobList,jobDetail,jobLookupKey} from "./jobs-contract.ts";

async function read(name:string,args:Record<string,unknown>) {
  const client = createServiceSupabaseClient({fetch:(url,init)=>fetch(url,{...init,cache:"no-store"})});
  const {data,error} = await client.rpc(name,args);
  if (error) throw new Error("Public jobs temporarily unavailable");
  return data;
}
export async function listPublicJobs(filters: JobsQuery) {
  return jobList.parse(await read("recruitment_post_public_portal_list_v1",{p_filters:filters}));
}
export async function getPublicJob(slug:string) {
  const key=slug.trim().toLowerCase();
  if (key.length>120 || !jobLookupKey.test(key)) return null;
  const data=await read("recruitment_post_public_portal_get_v1",{p_slug_or_code:key});
  return data===null?null:jobDetail.parse(data);
}
