export default function Contact(){
  const phone=process.env.PUBLIC_JOBS_APPROVED_HOTLINE;
  const zalo=process.env.PUBLIC_JOBS_APPROVED_ZALO;
  const tel=phone && /^\+?[0-9]{9,15}$/.test(phone) ? phone : null;
  const link=zalo && /^https:\/\/zalo\.me\/[0-9]{9,15}$/.test(zalo) ? zalo : null;
  return <main className="jobs-info"><h1>Liên hệ tuyển dụng</h1>{tel && <p><a href={"tel:"+tel}>Gọi {tel}</a></p>}{link && <p><a href={link} rel="noreferrer">Liên hệ qua Zalo</a></p>}{!tel&&!link && <p>Kênh liên hệ tuyển dụng đang được cập nhật.</p>}<a href="/viec-lam">Xem việc đang tuyển</a></main>;
}
