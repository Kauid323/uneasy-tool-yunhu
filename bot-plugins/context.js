module.exports = {
  createPluginContext(deps = {}) {
    return {
      axios: deps.axios,
      crypto: deps.crypto,
      config: deps.config,
      fs: deps.fs,
      path: deps.path,
      ncmRequest: deps.ncmRequest,
      ncmSongDetail: deps.ncmSongDetail,
      ncmPlaylistDetail: deps.ncmPlaylistDetail,
      ncmSongUrlV1: deps.ncmSongUrlV1,
      ncmSongUrl: deps.ncmSongUrl,
      randomChoice: deps.randomChoice,
      safeJsonParse: deps.safeJsonParse,
      secondsToDurationText: deps.secondsToDurationText,
      formatNum: deps.formatNum,
      fetchHtmlWithRedirect: deps.fetchHtmlWithRedirect,
      buildBiliCookie: deps.buildBiliCookie,
      getWbiKeys: deps.getWbiKeys,
      encWbi: deps.encWbi,
      pickModule: deps.pickModule,
      ksDecodeInitState: deps.ksDecodeInitState,
      ksGetFinalStablePathUltimate: deps.ksGetFinalStablePathUltimate,
      rootUtils: deps.rootUtils || {}
    };
  }
};
