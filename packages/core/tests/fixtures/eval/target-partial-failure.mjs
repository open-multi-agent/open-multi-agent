export default {
  async target(input) {
    if (input === 'world') throw new Error('target failed')
    return { output: String(input).toUpperCase() }
  },
  scorers: [{
    name: 'exact',
    score({ output, evalCase }) {
      const pass = output === evalCase.expected
      return { score: pass ? 1 : 0, pass }
    },
  }],
}
