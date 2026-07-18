export default [{
  name: 'exact',
  version: '1',
  score({ output, evalCase }) {
    const pass = output === evalCase.expected
    return { score: pass ? 1 : 0, pass }
  },
}]
