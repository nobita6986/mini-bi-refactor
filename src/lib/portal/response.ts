export function portalJson(body:unknown,status=200) {
  return Response.json(body,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
}
