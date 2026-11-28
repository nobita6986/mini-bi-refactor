import {parseJobsQuery} from "@/lib/portal/jobs-contract";
import {listPublicJobs} from "@/lib/portal/jobs-reader";
import {SpatialExplorer} from "@/components/portal/spatial-explorer";
import {SHIFT_PATTERN_LABELS,GENDER_REQUIREMENT_LABELS,formatRecruitmentPostIncomeRange} from "@/lib/recruitment-posts/recruitment-post-ui-model";

export const dynamic="force-dynamic";
export const metadata={alternates:{canonical:"/viec-lam"}};
export default async function JobsPage({searchParams}:PageProps<"/portal/viec-lam">){
  const entries=await searchParams;
  const params=new URLSearchParams();
  for (const [k,v] of Object.entries(entries)) for (const s of Array.isArray(v)?v:v===undefined?[]:[v]) if(s!=="")params.append(k,s);
  const filters=parseJobsQuery(params);
  if(!filters) return <main className="jobs-info"><h1>Bộ lọc chưa hợp lệ</h1><a href="/viec-lam">Đặt lại bộ lọc</a></main>;
  let data;
  try {data=await listPublicJobs(filters);} catch {
    return <main className="jobs-info"><h1>Chưa tải được việc làm</h1><p>Vui lòng thử tải lại sau ít phút.</p><a href={"/viec-lam?"+params}>Thử lại</a></main>;
  }
  const {items,pagination,facets}=data;
  const pagelink=(p:number)=>{const next=new URLSearchParams(params);next.set("page",String(p));return "/viec-lam?"+next};
  return <main className="jobs-main"><h1>Việc làm tại miền Bắc</h1>
    <form method="get" action="/viec-lam" className="jobs-filters">
      <label>Từ khóa<input name="q" type="search" defaultValue={filters.q} maxLength={120} placeholder="Tên công ty, công việc…"/></label>
      <label>Tỉnh, thành<select name="province_code" defaultValue={filters.province_code}><option value="">Tất cả tỉnh</option>{facets.provinces.map(p=><option key={p.province_code} value={p.province_code}>{p.display_name} ({p.job_count})</option>)}</select></label>
      <label>Khu công nghiệp<select name="industrial_park_code" defaultValue={filters.industrial_park_code}><option value="">Tất cả KCN</option>{facets.industrial_parks.map(p=><option key={p.industrial_park_code} value={p.industrial_park_code}>{p.display_name} ({p.job_count})</option>)}</select></label>
      <label>Loại lao động<select name="labor_type_key" defaultValue={filters.labor_type_key}><option value="">Tất cả loại</option>{facets.labor_types.map(p=><option key={p.labor_type_key} value={p.labor_type_key}>{p.display_name}</option>)}</select></label>
      <details><summary>Lọc thêm</summary><div><label>Ca làm<select name="shift_pattern" defaultValue={filters.shift_pattern}><option value="">Tất cả</option>{Object.entries(SHIFT_PATTERN_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
      <label>Giới tính<select name="gender_requirement" defaultValue={filters.gender_requirement}><option value="">Tất cả</option>{Object.entries(GENDER_REQUIREMENT_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
      <label><input type="checkbox" name="salary_advance_available" value="true" defaultChecked={filters.salary_advance_available==="true"}/> Có ứng lương</label>
      <label>Sắp xếp<select name="sort" defaultValue={filters.sort}><option value="updated_desc">Mới cập nhật</option><option value="published_desc">Mới đăng</option></select></label></div></details>
      <button type="submit">Tìm việc</button>
    </form>
    <SpatialExplorer jobs={items} tileConfig={tileSettings()}>
    <section className="job-results"><h2>{pagination.total_count} tin tuyển dụng</h2>
    {items.length===0 && <p>Chưa tìm thấy tin phù hợp. <a href="/viec-lam">Xem tất cả việc làm</a></p>}
    <ul>{items.map(j=><li key={j.public_slug}><a data-job={j.public_slug} href={"/viec-lam/"+j.public_slug}><strong>{j.general.customer_name}</strong><span>{j.location.industrial_park_name} · {j.location.province_name}</span><span>{j.general.job_description}</span><b>{formatRecruitmentPostIncomeRange(j.compensation.average_income_min_vnd,j.compensation.average_income_max_vnd)}</b></a></li>)}</ul>
    {pagination.total_pages>1&&<nav aria-label="Phân trang">{pagination.page>1&&<a href={pagelink(pagination.page-1)}>← Trang trước</a>} Trang {pagination.page} / {pagination.total_pages} {pagination.page<pagination.total_pages&&<a href={pagelink(pagination.page+1)}>Trang sau →</a>}</nav>}</section>
    </SpatialExplorer></main>;
}
function tileSettings(){
  const origin=process.env.PUBLIC_JOBS_TILE_ORIGIN;
  const credit=process.env.PUBLIC_JOBS_TILE_ATTRIBUTION?.trim();
  if (!origin||!credit) return null;
  try {const u=new URL(origin);return u.protocol==="https:"&&u.origin===origin ? {origin:u.origin,credit}:null;}catch{return null;}
}
