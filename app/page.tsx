"use client";
import { useState } from "react";
export default function Home() {
  const [file,setFile]=useState<File|null>(null);
  const [status,setStatus]=useState("PDF faylni tanlang");
  function handleFile(selected:File|undefined){
    if(!selected)return;
    if(selected.type!=="application/pdf"&&!selected.name.toLowerCase().endsWith(".pdf")){setFile(null);setStatus("Faqat PDF fayl qabul qilinadi");return;}
    setFile(selected);setStatus("PDF qabul qilindi — tarjimaga tayyor");
  }
  return <main className="shell">
    <header className="nav"><div className="brand"><span>AI</span> Manga Translator</div><div className="badge">MVP • v0.1</div></header>
    <section className="hero">
      <div className="eyebrow">AI TRANSLATION PIPELINE</div>
      <h1>PDF manga → <span>AI tarjima</span> → PDF</h1>
      <p>Bobni PDF ko‘rinishida yuklang. Tizim matnni aniqlaydi, tarjima qiladi va tayyor tarjima qilingan bobni qaytaradi.</p>
      <label className="upload">
        <input type="file" accept=".pdf,application/pdf" onChange={e=>handleFile(e.target.files?.[0])}/>
        <div className="uploadIcon">↑</div>
        <strong>{file?file.name:"PDF faylni shu yerga tanlang"}</strong>
        <small>{file?((file.size/1024/1024).toFixed(2)+" MB"):"Faqat .pdf format"}</small>
      </label>
      <div className={file?"status success":"status"}>{status}</div>
      <button className="primary" disabled={!file} onClick={()=>setStatus("Upload pipeline keyingi bosqichda ulanadi")}>{file?"AI tarjimani boshlash":"Avval PDF tanlang"}</button>
    </section>
    <section className="pipeline">
      {[["01","PDF Upload","Faylni xavfsiz qabul qilish"],["02","Text Detection","Sahifalardagi matnni aniqlash"],["03","AI Translation","Kontekstga mos tarjima"],["04","PDF Export","Tayyor tarjima qilingan bob"]].map(([n,title,desc])=><article key={n}><span>{n}</span><h3>{title}</h3><p>{desc}</p></article>)}
    </section>
    <footer>AI Manga Translator • Translation core first</footer>
  </main>;
}
