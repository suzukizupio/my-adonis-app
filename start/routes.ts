/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import { middleware } from '#start/kernel'
import { controllers } from '#generated/controllers'
import router from '@adonisjs/core/services/router'

const IteneDashboardController = () => import('#controllers/itene_dashboard_controller')

router
  .group(() => {
    router.get('signup', [controllers.NewAccount, 'create'])
    router.post('signup', [controllers.NewAccount, 'store'])

    router.get('login', [controllers.Session, 'create'])
    router.post('login', [controllers.Session, 'store'])
  })
  .use(middleware.guest())

router
  .group(() => {
    router.get('/', [IteneDashboardController, 'index']).as('home')
    router.get('/dashboard', [IteneDashboardController, 'index']).as('dashboard')
    router.get('/constructions/:id', [IteneDashboardController, 'show']).as('constructions.show')
    router.post('logout', [controllers.Session, 'destroy'])
  })
  .use(middleware.auth())
