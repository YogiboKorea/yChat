// fine_tuning_transform.js
const fs = require("fs");
const path = require("path");

// json 폴더 안의 companyData.json 파일 경로를 지정
const inputFilePath = path.join(__dirname, "json", "companyData.json");
const outputFilePath = path.join(__dirname, "fine_tuning_data.jsonl");

// 원본 JSON 데이터 읽기
const rawData = JSON.parse(fs.readFileSync(inputFilePath, "utf-8"));
const output = [];

// 각 카테고리별 데이터 순회
for (const category in rawData) {
  const items = rawData[category];
  for (const question in items) {
    let answer = items[question].answer || items[question].description || "";
    let additionalInfo = "";
    if (items[question].videoUrl) {
      additionalInfo += ` [Video URL: ${items[question].videoUrl}]`;
    }
    if (items[question].imageUrl) {
      additionalInfo += ` [Image URL: ${items[question].imageUrl}]`;
    }

    // 카테고리 정보 + 질문을 prompt로, 답변을 completion으로
    const prompt = `[${category}] ${question}`;
    const completion = `${answer}${additionalInfo}`;

    output.push({
      prompt,
      completion
    });
  }
}

// JSONL 파일로 저장
fs.writeFileSync(outputFilePath, output.map(item => JSON.stringify(item)).join("\n"));
console.log("JSONL 파일이 생성되었습니다:", outputFilePath);
