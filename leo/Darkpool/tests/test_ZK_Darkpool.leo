// The 'test_ZK_Darkpool' test program.
import ZK_Darkpool.aleo;
program test_ZK_Darkpool.aleo {
    @test
    script test_it() {
        let result: u32 = ZK_Darkpool.aleo/main(1u32, 2u32);
        assert_eq(result, 3u32);
    }

    @test
    @should_fail
    transition do_nothing() {
        let result: u32 = ZK_Darkpool.aleo/main(2u32, 3u32);
        assert_eq(result, 3u32);
    }

    @noupgrade
    async constructor() {}
}
