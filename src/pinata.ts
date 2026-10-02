type TokenMetadataInput = {
  image: { buffer: Buffer; mimeType: string; filename: string };
  name: string;
  symbol: string;
  description: string;
  twitter?: string;
  telegram?: string;
  website?: string;
};

async function uploadPinataFile(file: Blob, filename: string): Promise<string> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error("PINATA_JWT is not configured");

  const form = new FormData();
  form.append("network", "public");
  form.append("file", file, filename);

  const response = await fetch("https://uploads.pinata.cloud/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form
  });

  const body: any = await response.json().catch(() => null);
  if (!response.ok || !body?.data?.cid) {
    throw new Error(`Pinata upload failed: ${response.status} ${JSON.stringify(body).slice(0, 700)}`);
  }

  return String(body.data.cid);
}

export async function uploadTokenMetadata(input: TokenMetadataInput) {
  const imageBlob = new Blob([input.image.buffer], { type: input.image.mimeType || "application/octet-stream" });
  const imageCid = await uploadPinataFile(imageBlob, input.image.filename || "token-image");
  const imageUri = `https://ipfs.io/ipfs/${imageCid}`;

  const metadata = {
    name: input.name,
    symbol: input.symbol,
    image: imageUri,
    description: input.description,
    twitter: input.twitter || "",
    telegram: input.telegram || "",
    website: input.website || ""
  };

  const metadataBlob = new Blob([JSON.stringify(metadata)], { type: "application/json" });
  const metadataCid = await uploadPinataFile(metadataBlob, "metadata.json");
  const metadataUri = `https://ipfs.io/ipfs/${metadataCid}`;

  return { imageCid, imageUri, metadataCid, metadataUri, metadata };
}
