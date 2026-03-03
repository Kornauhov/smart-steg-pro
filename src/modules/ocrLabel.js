import Tesseract from "tesseract.js";

export async function ocrLabelFromImageFile(file, onProgress) {
  if (!file) throw new Error("Kein Bild ausgewählt.");

  const { data } = await Tesseract.recognize(file, "deu", {
    logger: (m) => {
      if (m?.status === "recognizing text" && typeof onProgress === "function") {
        onProgress(Math.round((m.progress || 0) * 100));
      }
    },
  });

  return data.text || "";
}
