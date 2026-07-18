export default {
  async target() {
    throw new Error('target failed')
  },
  scorers: [{ name: 'exact', score: () => ({ score: 1, pass: true }) }],
}
