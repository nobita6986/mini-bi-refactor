import {PUBLIC_JOB_ORIGIN} from "./host.ts";
import {listPublicJobs} from "./jobs-reader.ts";
export async function jobSitemap(page?:number){
  const headers={"Content-Type":"application/xml; charset=UTF-8","Cache-Control":"no-store"};
  try {
    const data=await listPublicJobs({page:page??1,page_size:50,sort:"updated_desc"});
    if(page && page>1 && !data.items.length) return new Response(null,{status:404,headers});
    const base=' xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
    const xml=page? "<urlset"+base+">"+(page===1?["/","/viec-lam","/gioi-thieu","/lien-he"]:[]).concat(data.items.map(j=>"/viec-lam/"+j.public_slug)).map(p=>"<url><loc>"+PUBLIC_JOB_ORIGIN+p+"</loc></url>").join("")+"</urlset>":
      "<sitemapindex"+base+">"+Array.from({length:Math.max(data.pagination.total_pages,1)},(_,i)=>"<sitemap><loc>"+PUBLIC_JOB_ORIGIN+"/sitemap/"+(i+1)+"</loc></sitemap>").join("")+"</sitemapindex>";
    return new Response(xml,{headers});
  } catch {return new Response(null,{status:503,headers});}
}
