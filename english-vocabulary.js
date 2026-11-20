"use strict";
const COMMON_WORDS = new Set([
  "the","and","for","are","but","not","you","all","can","had","her","was",
  "one","our","out","day","get","has","him","his","how","man","new","now",
  "old","see","two","way","who","boy","did","its","let","put","say","she",
  "too","use","that","with","have","this","will","your","from","they","know",
  "want","been","good","much","some","time","very","when","come","here","just",
  "like","long","make","many","more","only","over","such","take","than","them",
  "well","were","what","form","won","saw","teh","adn","definately","seperate",
  "occured","recieve"
]);
function isLikelyEnglishWord(word) {
  if (typeof word !== "string" || !/^[A-Za-z']+$/.test(word)) return false;
  return !COMMON_WORDS.has(word.toLowerCase());
}
module.exports = { isLikelyEnglishWord };
