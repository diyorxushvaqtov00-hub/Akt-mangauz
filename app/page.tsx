"use client";
import { useState } from "react";

export default function Home() {
  const [file,setFile]=useState<File|null>(null);
  const [status,setStatus]=useState("PDF faylni tanlang");
  const [busy,setBusy]=useState(false);
  const [translation,setTranslation]=useState("");

  async function startUpload() {
    if (!file || busy) return;
    setBusy(true); setTranslation(""); setStatus("Upload URL tayyorlanmoqda...");
    try {
      const init=await fetch("/api/upload/init",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:file.name,size:file.size})});
      const initData=await init.json();
      if(!init.ok) throw new Error(initData.error || "Upload init xatosi");

      setStatus("PDF yuklanmoqda...");
      const upload=await fetch(initData.signedUrl,{method:"PUT",headers:{"Content-Type":"application/pdf","x-upsert":"false"},body:file});
      if(!upload.ok) throw new Error("PDF Storage'ga yuklanmadi");

      setStatus("PDF qabul qilindi. Tekshirilmoqda...");
      const complete=await fetch("/api/upload/complete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jobId:initData.jobId,path:initData.path})});
      const completeData=await complete.json();
      if(!complete.ok) throw new Error(completeData.error || "Tekshiruv xatosi");

      setStatus("AI PDF'ni o‘qiyapti va tarjima qilmoqda...");
      const translate=await fetch("/api/translate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jobId:initData.jobId,path:initData.path,targetLanguage:"Uzbek"})});
      const translateData=await translate.json();
      if(!translate.ok) throw new Error(translateData.error || translateData.detail || "AI tarjima xatosi");

      setTranslation(translateData.translation || "");
      setStatus("AI tarjima muvaffaqiyatli tugadi.");
    } catch(error) {
      setStatus(error instanceof Error ? "X "+error.message : "Upload/AI xatosi");
    } finally { setBusy(false); }
  }

  return <main className="shell">
    <header className="nav"><div className="brand"><span>AI</span> Manga Translator</div><div className="badge">MVP • v0.3</div></header>
    <section className="hero">
      <div className="eyebrow">AI TRANSLATION PIPELINE</div>
      <h1>PDF manga → <span>AI tarjima</span> → PDF</h1>
      <p>Bobni PDF ko‘rinishida yuklang. Tizim PDF'ni AI'ga yuboradi, matnni aniqlaydi va o‘zbekchaga tarjima qiladi.</p>
      <label className="upload">
        <input type="file" accept=".pdf,application/pdf" onChange={e=>{const f=e.target.files?.[0];if(!f)return;if(f.type!=="application/pdf"&&!f.name.toLowerCase().endsWith(".pdf")){setFile(null);setStatus("Faqat PDF fayl qabul qilinadi");return;}if(f.size>100*1024*1024){setFile(null);setStatus("PDF 100 MB dan kichik bo‘lishi kerak");return;}setFile(f);setTranslation("");setStatus("PDF qabul qilindi — AI tarjimaga tayyor");}}/>
        <div className="uploadIcon">↑</div><strong>{file?file.name:"PDF faylni shu yerga tanlang"}</strong>
        <small>{file?((file.size/1024/1024).toFixed(2)+" MB"):"Faqat .pdf • maksimum 100 MB"}</small>
      </label>
      <div className={file?"status success":"status"}>{status}</div>
      <button className="primary" disabled={!file||busy} onClick={startUpload}>{busy?"AI ishlayapti...":file?"PDF'ni AI tarjimaga yuborish":"Avval PDF tanlang"}</button>
      {translation && <div className="status success" style={{marginTop:16,textAlign:"left",whiteSpace:"pre-wrap",maxHeight:420,overflow:"auto"}}>{translation}</div>}
    </section>
    <section className="pipeline">{[["01","PDF Upload","Faylni xavfsiz qabul qilish"],["02","AI Text Detection","PDF sahifalaridagi matnni o‘qish"],["03","AI Translation","O‘zbek tiliga kontekstli tarjima"],["04","PDF Export","Tarjima matnini original sahifalarga joylashtirish"]].map(([n,title,desc])=><article key={n}><span>{n}</span><h3>{title}</h3><p>{desc}</p></article>)}</section>
    <footer>AI Manga Translator • Translation core first</footer>
  </main>;
}
