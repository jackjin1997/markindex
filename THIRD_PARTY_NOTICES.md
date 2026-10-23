# Third-party notices

MarkIndex is an independent TypeScript implementation. It contains no PageIndex source code, but parts of it are
adapted from [VectifyAI/PageIndex](https://github.com/VectifyAI/PageIndex):

- the agent instructions (`AGENT_INSTRUCTIONS`) and the tool descriptions in `src/tools/contract.ts`, and the
  summarization prompts in `src/llm/summarize.ts`, are adapted from PageIndex's agent tools and prompts
  (pages replaced by line ranges);
- the tree-optimization cost model in `src/tree/optimize.ts` (merge / expand by token cost) is a port of
  PageIndex's `tree_optimize.py`, with pages replaced by tokens.

PageIndex is distributed under the following license:

```
MIT License

Copyright (c) 2025 Vectify AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
