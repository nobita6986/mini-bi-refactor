import {cache} from "react";
import {notFound,permanentRedirect} from "next/navigation";
import {getPublicJob} from "@/lib/portal/jobs-reader";
import {PUBLIC_JOB_ORIGIN} from "@/lib/portal/host";
import {formatRecruitmentPostVnd,formatRecruitmentPostIncomeRange,formatRecruitmentPostAgeRange,SHIFT_PATTERN_LABELS,WORK_POSTURE_LABELS,ENVIRONMENT_TYPE_LABELS,EDUCATION_REQUIREMENT_LABELS} from "@/lib/recruitment-posts/recruitment-post-ui-model";
export const dynamic="force-dynamic";
const get=cache(getPublicJob);
export async function generateMetadata({params}:PageProps<"/portal/viec-lam/[slug]">){
  const {slug}=await params;
  let d;
  try {
    d=await get(slug);
  } catch {
    return {title:"Chưa tải được tin tuyển dụng",robots:{index:false}};
  }
  if (!d) return {title:"Tin tuyển dụng không còn hiển thị",robots:{index:false}};
  const title=d.item.general.customer_name+" · "+d.item.location.industrial_park_name;
  const url="/viec-lam/"+d.canonical_slug;
  return {title,description:d.item.general.job_description.slice(0,220),alternates:{canonical:url},openGraph:{title,url}};
}
export default async function JobDetail({params}:PageProps<"/portal/viec-lam/[slug]">){
  const {slug}=await params;
  let d;
  try {
    d=await get(slug);
  } catch {
    return <main className="jobs-info"><h1>Chưa tải được tin tuyển dụng</h1><p>Vui lòng thử tải lại sau ít phút.</p><p><a href={"/viec-lam/"+encodeURIComponent(slug)}>Thử lại</a> · <a href="/viec-lam">Danh sách việc làm</a></p></main>;
  }
  if(!d)notFound();
  if(d.match_status==="FOUND_ALIAS"||slug!==d.canonical_slug)permanentRedirect("/viec-lam/"+d.canonical_slug);
  const j=d.item, {general:g,candidate:c,compensation:pay,documents:docs}=j;
  const documentFields=[
    [docs.require_original_cccd_and_copy,"CCCD gốc và bản sao"],[docs.require_certified_resume,"Sơ yếu lý lịch có xác nhận"],[docs.require_health_certificate_within_6_months,"Giấy khám sức khỏe trong 6 tháng"],
    [docs.require_photo_3x4,"Ảnh 3×4"],[docs.require_degree_or_certificate,"Bằng cấp hoặc chứng chỉ"],[docs.require_social_insurance_book,"Sổ bảo hiểm xã hội"],
  ] as const;
  const sections: [string,[string,string|null|undefined][]][]=[
    ["Công việc",[["Mô tả",g.job_description],["Ca làm",SHIFT_PATTERN_LABELS[g.shift_pattern]],["Chi tiết ca",g.shift_details],["Loại lao động",g.labor_types.map(l=>l.display_name).join(", ")],["Môi trường",g.environment_types.map(e=>ENVIRONMENT_TYPE_LABELS[e]).join(", ")],["Tư thế",g.work_postures.map(p=>WORK_POSTURE_LABELS[p]).join(", ")],["Ngành sản xuất",g.manufacturing_industry],["Nhu cầu tuyển",g.expected_headcount==null?null:String(g.expected_headcount)],["Lịch tiếp nhận",g.supply_schedule_text]]],
    ["Yêu cầu ứng viên",[["Độ tuổi",formatRecruitmentPostAgeRange(c.age_min,c.age_max)],["Giới tính",c.gender_label],["Học vấn",EDUCATION_REQUIREMENT_LABELS[c.education_requirement]],["Kinh nghiệm",c.experience_details],["Đánh giá đầu vào",c.entry_assessment_text],["Yêu cầu khác",c.other_requirements_text]]],
    ["Lương và phụ cấp",[["Lương cơ bản",formatRecruitmentPostVnd(pay.base_salary_vnd)],["Điều kiện",pay.base_salary_conditions],["Thu nhập trung bình",formatRecruitmentPostIncomeRange(pay.average_income_min_vnd,pay.average_income_max_vnd)],["Lịch trả lương",pay.salary_payment_schedule],["Chuyên cần",formatRecruitmentPostVnd(pay.attendance_bonus_vnd)],["Phụ cấp sinh hoạt",formatRecruitmentPostVnd(pay.living_allowance_vnd)],["Phụ cấp khác",pay.other_allowance_text],["Ứng lương",pay.salary_advance_available?formatRecruitmentPostVnd(pay.salary_advance_amount_vnd):null],["Lịch ứng",pay.salary_advance_schedule]]],
    ["Hồ sơ",[["Giấy tờ",documentFields.filter(([required])=>required).map(([,v])=>v).join(", ")],["Giấy tờ khác",docs.other_documents_text]]],
  ];
  const posting={"@context":"https://schema.org","@type":"JobPosting",title:g.job_description.split("\n")[0],description:g.job_description,datePosted:j.published_at,hiringOrganization:{"@type":"Organization",name:g.customer_name},jobLocation:{"@type":"Place",name:j.location.industrial_park_name,address:{"@type":"PostalAddress",addressRegion:j.location.province_name,addressCountry:"VN"}},url:PUBLIC_JOB_ORIGIN+"/viec-lam/"+j.public_slug};
  return <main className="jobs-info"><a href="/viec-lam">← Danh sách việc làm</a><h1>{g.customer_name}</h1><p>{j.location.industrial_park_name} · {j.location.province_name}</p>
  {g.job_description&&g.customer_name&&j.location.province_name&&<script type="application/ld+json" dangerouslySetInnerHTML={{__html:JSON.stringify(posting).replace(/</g,"\\u003c")}}/>}
  {sections.map(([title,lines])=><section key={title}><h2>{title}</h2><dl>{lines.filter(([,v])=>v).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></section>)}<a href="/lien-he">Liên hệ tuyển dụng</a>
  {d.related_items.length>0&&<section><h2>Việc cùng khu công nghiệp</h2><ul>{d.related_items.map(job=><li key={job.public_slug}><a href={"/viec-lam/"+job.public_slug}>{job.general.customer_name} · {job.general.job_description}</a></li>)}</ul></section>}
  </main>;
}
