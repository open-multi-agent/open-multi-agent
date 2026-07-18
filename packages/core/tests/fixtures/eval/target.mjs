const target = async (input) => ({ output: String(input).toUpperCase() })

const exact = {
  name: 'exact',
  version: '1',
  score({ output, evalCase }) {
    const pass = output === evalCase.expected
    return { score: pass ? 1 : 0, pass, reason: pass ? 'matched' : 'mismatch' }
  },
}

export default { target, scorers: [exact] }
