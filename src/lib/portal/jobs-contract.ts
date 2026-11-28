import { z } from "zod";
import {
  CATALOG_CODE_PATTERN, LABOR_TYPE_KEY_PATTERN, RECRUITMENT_POST_SHIFT_PATTERNS,
  RECRUITMENT_POST_GENDER_REQUIREMENTS, projectRecruitmentPostPublicJobItemV1,
} from "../recruitment-posts/contract.ts";

const unsigned = z.string().regex(/^[1-9]\d{0,9}$/).transform(Number);
const query = z.strictObject({
  q: z.string().trim().max(120).optional(),
  province_code: z.string().regex(CATALOG_CODE_PATTERN).optional(),
  industrial_park_code: z.string().regex(CATALOG_CODE_PATTERN).optional(),
  labor_type_key: z.string().regex(LABOR_TYPE_KEY_PATTERN).optional(),
  shift_pattern: z.enum(RECRUITMENT_POST_SHIFT_PATTERNS).optional(),
  gender_requirement: z.enum(RECRUITMENT_POST_GENDER_REQUIREMENTS).optional(),
  salary_advance_available: z.literal("true").optional(),
  sort: z.enum(["updated_desc","published_desc"]).default("updated_desc"),
  page: unsigned.pipe(z.int().max(2147483647)).default(1),
  page_size: unsigned.pipe(z.int().max(50)).default(12),
});
export type JobsQuery = z.output<typeof query>;
export function parseJobsQuery(params: URLSearchParams) {
  for (const key of params.keys()) if (params.getAll(key).length !== 1) return null;
  return query.safeParse(Object.fromEntries(params)).data ?? null;
}

export const jobLookupKey = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const canonical = z.string().max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const item = z.record(z.string(),z.unknown()).transform((record,ctx) => {
  const {public_slug, ...base} = record;
  const job = projectRecruitmentPostPublicJobItemV1(base);
  if (!job || typeof public_slug !== "string" || !canonical.safeParse(public_slug).success || !public_slug.endsWith("-"+job.brief_id)) {
    ctx.addIssue({code:"custom",message:"Invalid public job"});
    return z.NEVER;
  }
  return {...job,public_slug};
});
export type PublicJob = z.output<typeof item>;
const count = z.int().nonnegative();
const facet = z.object({display_name:z.string().min(1),job_count:count});
const collator = new Intl.Collator("vi");
function order<T extends {display_name:string}>(items:T[], code:(v:T)=>string) {
  return items.sort((a,b)=>collator.compare(a.display_name,b.display_name)||code(a).localeCompare(code(b)));
}
export const jobList = z.strictObject({
  items:z.array(item).max(50),
  pagination:z.strictObject({page:z.int().positive(),page_size:z.int().min(1).max(50),total_count:count,total_pages:count}),
  facets:z.strictObject({
    total_published_count:count,
    provinces:z.array(facet.extend({province_code:z.string().regex(CATALOG_CODE_PATTERN)}).strict()).transform(v=>order(v,i=>i.province_code)),
    industrial_parks:z.array(facet.extend({industrial_park_code:z.string().regex(CATALOG_CODE_PATTERN),province_code:z.string().regex(CATALOG_CODE_PATTERN)}).strict()).transform(v=>order(v,i=>i.industrial_park_code)),
    labor_types:z.array(facet.extend({labor_type_key:z.string().regex(LABOR_TYPE_KEY_PATTERN)}).strict()).transform(v=>order(v,i=>i.labor_type_key)),
  }),
});
export const jobDetail = z.strictObject({
  match_status:z.enum(["FOUND_CANONICAL","FOUND_ALIAS"]),canonical_slug:canonical,item,related_items:z.array(item).max(3),
}).refine(d=>d.canonical_slug===d.item.public_slug);
