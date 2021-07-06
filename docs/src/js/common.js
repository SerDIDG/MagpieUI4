if(cm._baseUrl.indexOf('serdidg.github.io') > -1){
    cm._baseUrl = [cm._baseUrl, '/MagpieUI4/docs/dist'].join('/');
}else{
    cm._baseUrl = [cm._baseUrl, 'docs/dist'].join('/');
}
cm._assetsUrl = cm._baseUrl;
